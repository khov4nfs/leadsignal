import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ConnectionStatus,
  LlmProvider,
  LlmTaskType,
  PriorityLevel,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../database/prisma.service';
import { ProductionService } from '../production/production.service';
import { AnthropicStrategy } from './anthropic.strategy';
import { GeminiStrategy } from './gemini.strategy';
import type { LlmStrategy, StrategyConnection } from './llm.types';
import { StrategyError } from './llm.types';
import { OpenAiCompatibleStrategy } from './openai-compatible.strategy';
import { RuleEngineStrategy } from './rule-engine.strategy';
import { SlotManagerService } from './slot-manager.service';

@Injectable()
export class LlmPoolRouterService {
  private readonly logger = new Logger(LlmPoolRouterService.name);
  private readonly strategies: LlmStrategy[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly slots: SlotManagerService,
    private readonly production: ProductionService,
    openAi: OpenAiCompatibleStrategy,
    anthropic: AnthropicStrategy,
    gemini: GeminiStrategy,
    rule: RuleEngineStrategy,
  ) {
    this.strategies = [openAi, anthropic, gemini, rule];
  }

  async classify(
    workspaceId: string,
    post: { id: string; title: string; body: string; subreddit: string },
  ) {
    const correlationId = randomUUID();
    const policy = await this.prisma.llmRoutingPolicy.findFirst({
      where: {
        workspaceId,
        taskType: LlmTaskType.BUYING_SIGNAL_CLASSIFICATION,
        enabled: true,
      },
      orderBy: { version: 'desc' },
      include: {
        routes: { where: { enabled: true }, orderBy: { tier: 'asc' } },
      },
    });
    const routes = policy?.routes ?? [];
    const failures: string[] = [];

    if (routes.length === 0) {
      failures.push('NO_ENABLED_LLM_ROUTES');
    }

    for (const route of routes) {
      if (route.provider === LlmProvider.RULE_ENGINE) {
        if (failures.length > 0) {
          this.logger.warn(
            `Falling back to RULE_ENGINE for post ${post.id}: ${failures.join(', ')}`,
          );
        } else if (routes.length === 1) {
          failures.push('NO_CONFIGURED_PROVIDER_ROUTE');
          this.logger.warn(
            `Only RULE_ENGINE is configured for workspace ${workspaceId}`,
          );
        }

        const strategy = this.strategy(route.provider);
        const result = await strategy.execute(
          { id: 'system', provider: LlmProvider.RULE_ENGINE },
          {
            model: route.model,
            title: post.title,
            body: post.body,
            subreddit: post.subreddit,
            timeoutMs: route.timeoutMs,
          },
        );
        return {
          correlationId,
          ...result,
          fallbackFailures: [...failures],
          priority: this.priority(result.output.buyingIntentScore),
        };
      }

      const connections = await this.prisma.llmConnection.findMany({
        where: {
          workspaceId,
          provider: route.provider,
          poolEnabled: true,
          deletedAt: null,
          status: {
            in: [ConnectionStatus.ACTIVE, ConnectionStatus.DEGRADED],
          },
          OR: [{ cooldownUntil: null }, { cooldownUntil: { lt: new Date() } }],
          models: { some: { model: route.model, enabled: true } },
        },
        include: { models: { where: { model: route.model } } },
        orderBy: [{ healthScore: 'desc' }, { lastUsedAt: 'asc' }],
      });

      if (connections.length === 0) {
        const failure = `${route.provider}/${route.model}:NO_ELIGIBLE_CONNECTION`;
        failures.push(failure);
        this.logger.warn(
          `Skipping route ${route.provider}/${route.model} for workspace ${workspaceId}: no active eligible connection`,
        );
        continue;
      }

      let accountAttempt = 0;
      for (const connection of connections) {
        accountAttempt++;
        const modelConfig = connection.models[0];
        const limit = Math.min(
          connection.ownerConcurrencyLimit,
          connection.workspaceConcurrencyCap ?? 999,
          modelConfig?.concurrencyLimit ?? 999,
        );
        const lease = await this.slots.tryAcquire(
          workspaceId,
          connection.id,
          route.model,
          limit,
        );
        if (!lease) {
          const failure = `${connection.name}/${route.model}:NO_CAPACITY`;
          failures.push(failure);
          this.logger.warn(
            `Skipping ${connection.name}/${route.model}: no concurrency slot available`,
          );
          continue;
        }

        try {
          const oauthCredential =
            await this.production.getFreshProviderCredential(connection.id);
          const credential =
            oauthCredential ??
            (connection.encryptedCredential &&
            connection.credentialIv &&
            connection.credentialAuthTag
              ? this.crypto.decrypt(
                  connection.encryptedCredential,
                  connection.credentialIv,
                  connection.credentialAuthTag,
                )
              : undefined);
          const strategyConnection: StrategyConnection = {
            id: connection.id,
            provider: connection.provider,
            credential,
            baseUrl: connection.baseUrl,
          };
          const strategy = this.strategy(connection.provider);

          for (let retry = 0; retry <= route.maxRetries; retry++) {
            const execution = await this.prisma.llmExecution.create({
              data: {
                correlationId,
                workspaceId,
                connectionId: connection.id,
                connectionOwnerUserId: connection.ownerUserId,
                taskType: LlmTaskType.BUYING_SIGNAL_CLASSIFICATION,
                resourceType: 'POST',
                resourceId: post.id,
                provider: connection.provider,
                model: route.model,
                routeTier: route.tier,
                accountAttempt,
                status: 'RUNNING',
                fallbackReason: failures.at(-1),
              },
            });
            try {
              const result = await strategy.execute(strategyConnection, {
                model: route.model,
                title: post.title,
                body: post.body,
                subreddit: post.subreddit,
                timeoutMs: route.timeoutMs,
              });
              await this.prisma.$transaction([
                this.prisma.llmExecution.update({
                  where: { id: execution.id },
                  data: {
                    status: 'SUCCEEDED',
                    inputTokens: result.inputTokens,
                    outputTokens: result.outputTokens,
                    latencyMs: result.latencyMs,
                    completedAt: new Date(),
                  },
                }),
                this.prisma.llmConnection.update({
                  where: { id: connection.id },
                  data: {
                    lastUsedAt: new Date(),
                    healthScore: Math.min(100, connection.healthScore + 1),
                    lastErrorCode: null,
                  },
                }),
              ]);
              return {
                correlationId,
                ...result,
                fallbackFailures: [...failures],
                priority: this.priority(result.output.buyingIntentScore),
              };
            } catch (error) {
              const normalized =
                error instanceof StrategyError
                  ? error
                  : new StrategyError(
                      String(error),
                      'UNKNOWN',
                      false,
                      true,
                    );
              const failure = `${connection.name}/${route.model}:${normalized.code}`;
              failures.push(failure);
              this.logger.warn(
                `LLM route failed for post ${post.id}: ${failure}; retry ${retry + 1}/${route.maxRetries + 1}`,
              );
              await this.prisma.llmExecution.update({
                where: { id: execution.id },
                data: {
                  status: 'FAILED',
                  errorCode: normalized.code,
                  errorMessage: normalized.message.slice(0, 500),
                  completedAt: new Date(),
                },
              });
              if (!normalized.retryable || retry === route.maxRetries) break;
            }
          }
        } catch (error) {
          const failure = `${connection.name}/${route.model}:${String(error)}`;
          failures.push(failure);
          this.logger.warn(`LLM connection failed: ${failure}`);
        } finally {
          await this.slots.release(lease);
        }
      }
    }
    throw new ServiceUnavailableException({
      code: 'ALL_LLM_ROUTES_FAILED',
      failures,
    });
  }

  private strategy(provider: LlmProvider) {
    const strategy = this.strategies.find((item) => item.supports(provider));
    if (!strategy) {
      throw new StrategyError(
        `No strategy for ${provider}`,
        'STRATEGY_NOT_FOUND',
        false,
        true,
      );
    }
    return strategy;
  }

  private priority(score: number): PriorityLevel {
    if (score >= 80) return PriorityLevel.CRITICAL;
    if (score >= 60) return PriorityLevel.HIGH;
    if (score >= 40) return PriorityLevel.MEDIUM;
    return PriorityLevel.LOW;
  }
}
