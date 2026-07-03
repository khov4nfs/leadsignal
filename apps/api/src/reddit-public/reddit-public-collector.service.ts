import { Logger } from '@nestjs/common';
import type { BrowserContext, Page } from 'playwright';
import { PrismaService } from '../database/prisma.service';
import { QueueService } from '../queue/queue.service';
import {
  assertRedditSession,
  launchRedditBackendContext,
} from './reddit-browser-profile';
import { enrichRedditPostDetails } from './reddit-detail-enricher';
import { navigateRedditPage } from './reddit-navigation';
import {
  extractRedditCards,
  REDDIT_POST_SELECTOR,
  type RedditPageCard,
} from './reddit-page-parser';
import type {
  RedditPublicCollectionResult,
  RedditPublicPost,
  RedditPublicSource,
} from './reddit-public.types';
import { resolvePublicRedditSourceUrl } from './reddit-source-url';

export interface RedditCollectionFilter {
  workspaceId?: string;
  sourceIds?: string[];
}

interface SourceConfigRow {
  sort: string;
  timeRange: string;
  targetPostCount: number;
  maxScrolls: number;
  maxStallRounds: number;
  includePromoted: boolean;
  includePinned: boolean;
  includeNsfw: boolean;
  detailEnabled: boolean;
  commentsTopN: number;
  collectionMode: string;
}

function enabled(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export class RedditPublicCollectorService {
  private readonly logger = new Logger(RedditPublicCollectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  async collect(
    filter: RedditCollectionFilter = {},
  ): Promise<RedditPublicCollectionResult> {
    if (!enabled(process.env.REDDIT_CRAWLER_ENABLED, false)) {
      return {
        workspaces: 0,
        sources: 0,
        posts: 0,
        failures: [],
        sourceResults: [],
      };
    }

    const sourceRecords = await this.prisma.redditSource.findMany({
      where: {
        enabled: true,
        ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
        ...(filter.sourceIds?.length ? { id: { in: filter.sourceIds } } : {}),
      },
      orderBy: [{ workspaceId: 'asc' }, { createdAt: 'asc' }],
    });
    const sources: RedditPublicSource[] = [];
    for (const source of sourceRecords) {
      const config = await this.loadConfig(source.id, source.type);
      sources.push({ ...source, ...config });
    }
    if (sources.length === 0) {
      return {
        workspaces: 0,
        sources: 0,
        posts: 0,
        failures: [],
        sourceResults: [],
      };
    }

    let context: BrowserContext | null = null;
    let posts = 0;
    const failures: Array<{ sourceId: string; message: string }> = [];
    const sourceResults: NonNullable<
      RedditPublicCollectionResult['sourceResults']
    > = [];
    const workspaces = new Set(sources.map((source) => source.workspaceId));
    const publicSources = sources.filter(
      (source) => source.collectionMode.toUpperCase() === 'PUBLIC',
    );

    for (const source of sources) {
      if (source.collectionMode.toUpperCase() === 'PUBLIC') continue;
      const message = 'Source requires the paired browser extension';
      await this.updateStatus(source.id, 'EXTENSION_REQUIRED', 0, message);
      sourceResults.push({
        sourceId: source.id,
        status: 'EXTENSION_REQUIRED',
        collected: 0,
        requested: source.targetPostCount,
        message,
      });
    }

    if (publicSources.length === 0) {
      return {
        workspaces: workspaces.size,
        sources: sources.length,
        posts: 0,
        failures,
        sourceResults,
      };
    }

    try {
      context = await launchRedditBackendContext();
      if (
        enabled(
          process.env.REDDIT_REQUIRE_AUTHENTICATED_PROFILE,
          false,
        )
      ) {
        await assertRedditSession(context);
      }

      for (const source of publicSources) {
        await this.updateStatus(source.id, 'RUNNING', 0, null);
        try {
          const collected = await this.collectSource(context, source);
          let discovered = 0;
          for (const record of collected) {
            if (await this.persist(source, record)) {
              posts += 1;
              discovered += 1;
            }
          }
          const status =
            collected.length >= source.targetPostCount ? 'DONE' : 'PARTIAL';
          await this.updateStatus(source.id, status, collected.length, null);
          sourceResults.push({
            sourceId: source.id,
            status,
            collected: collected.length,
            requested: source.targetPostCount,
            message:
              discovered === 0 && collected.length > 0
                ? 'Posts refreshed; no new discoveries'
                : undefined,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          failures.push({ sourceId: source.id, message });
          sourceResults.push({
            sourceId: source.id,
            status: 'FAILED',
            collected: 0,
            requested: source.targetPostCount,
            message,
          });
          await this.updateStatus(source.id, 'FAILED', 0, message);
          this.logger.warn(`Reddit source ${source.id} failed: ${message}`);
        }
      }
    } finally {
      await context?.close().catch(() => undefined);
    }

    return {
      workspaces: workspaces.size,
      sources: sources.length,
      posts,
      failures,
      sourceResults,
    };
  }

  private async loadConfig(
    sourceId: string,
    sourceType: string,
  ): Promise<SourceConfigRow> {
    const rows = await this.prisma.$queryRaw<SourceConfigRow[]>`
      SELECT
        sort,
        "timeRange",
        "targetPostCount",
        "maxScrolls",
        "maxStallRounds",
        "includePromoted",
        "includePinned",
        "includeNsfw",
        "detailEnabled",
        "commentsTopN",
        "collectionMode"
      FROM "RedditSourceConfig"
      WHERE "sourceId"=${sourceId}::uuid
      LIMIT 1
    `;
    return (
      rows[0] ?? {
        sort: 'NEW',
        timeRange: 'ALL',
        targetPostCount: Math.min(
          positiveInteger(process.env.REDDIT_CRAWLER_POSTS_PER_SOURCE, 50),
          2000,
        ),
        maxScrolls: Math.min(
          positiveInteger(process.env.REDDIT_CRAWLER_MAX_SCROLLS, 20),
          100,
        ),
        maxStallRounds: Math.min(
          positiveInteger(process.env.REDDIT_CRAWLER_MAX_STALL_ROUNDS, 4),
          12,
        ),
        includePromoted: false,
        includePinned: false,
        includeNsfw: false,
        detailEnabled: true,
        commentsTopN: 0,
        collectionMode:
          sourceType.toUpperCase() === 'FOLLOWING' ? 'EXTENSION' : 'PUBLIC',
      }
    );
  }

  private async updateStatus(
    sourceId: string,
    status: string,
    collected: number,
    error: string | null,
  ) {
    await this.prisma.$executeRaw`
      INSERT INTO "RedditSourceConfig" (
        "sourceId","lastRunAt","lastStatus","lastCollected","lastError","updatedAt"
      ) VALUES (
        ${sourceId}::uuid,NOW(),${status},${collected},${error},NOW()
      )
      ON CONFLICT ("sourceId") DO UPDATE SET
        "lastRunAt"=NOW(),
        "lastStatus"=EXCLUDED."lastStatus",
        "lastCollected"=EXCLUDED."lastCollected",
        "lastError"=EXCLUDED."lastError",
        "updatedAt"=NOW()
    `;
  }

  private async collectSource(
    context: BrowserContext,
    source: RedditPublicSource,
  ): Promise<RedditPublicPost[]> {
    const target = Math.max(1, Math.min(source.targetPostCount, 2000));
    const maxScrolls = Math.max(1, Math.min(source.maxScrolls, 100));
    const maxStalls = Math.max(1, Math.min(source.maxStallRounds, 12));
    const page = await context.newPage();
    const posts = new Map<string, RedditPublicPost>();
    let stalls = 0;
    let oldReddit = false;

    try {
      await this.navigate(page, resolvePublicRedditSourceUrl(source, false));
      oldReddit = page.url().includes('old.reddit.com');
      await this.waitForCards(page);

      for (
        let round = 0;
        round <= maxScrolls && posts.size < target;
        round += 1
      ) {
        const cards = await extractRedditCards(page);
        const sizeBefore = posts.size;

        for (const card of cards) {
          if (card.promoted && !source.includePromoted) continue;
          if (card.pinned && !source.includePinned) continue;
          if (card.nsfw && !source.includeNsfw) continue;
          const normalized = this.normalizeCard(source, card);
          if (!normalized || posts.has(normalized.externalPostId)) continue;
          posts.set(normalized.externalPostId, normalized);
          if (posts.size >= target) break;
        }

        if (posts.size >= target) break;
        if (posts.size === 0 && round >= 1 && source.subreddit && !oldReddit) {
          oldReddit = true;
          stalls = 0;
          await this.navigate(page, resolvePublicRedditSourceUrl(source, true));
          await this.waitForCards(page);
          continue;
        }

        stalls = posts.size === sizeBefore ? stalls + 1 : 0;
        if (stalls >= maxStalls) break;

        if (page.url().includes('old.reddit.com')) {
          const next = page
            .locator('span.next-button a, a[rel="nofollow next"]')
            .first();
          if (!(await next.isVisible().catch(() => false))) break;
          await Promise.all([
            page.waitForLoadState('domcontentloaded').catch(() => undefined),
            next.click(),
          ]);
          await this.waitForCards(page);
          continue;
        }

        await page.evaluate((selector) => {
          const candidates = Array.from(document.querySelectorAll(selector));
          candidates.at(-1)?.scrollIntoView({
            block: 'end',
            behavior: 'instant',
          });
          window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
        }, REDDIT_POST_SELECTOR);
        await Promise.race([
          page
            .waitForFunction(
              ({ selector, count }) =>
                document.querySelectorAll(selector).length > count,
              { selector: REDDIT_POST_SELECTOR, count: cards.length },
              { timeout: 8_000 },
            )
            .catch(() => undefined),
          page.waitForTimeout(1_800),
        ]);
      }

      const collected = [...posts.values()];
      if (!source.detailEnabled || collected.length === 0) return collected;
      return enrichRedditPostDetails(
        context,
        collected,
        source.commentsTopN,
        positiveInteger(process.env.REDDIT_DETAIL_CONCURRENCY, 2),
      );
    } finally {
      await page.close();
    }
  }

  private async navigate(page: Page, url: string): Promise<void> {
    await navigateRedditPage(page, url, {
      log: (message) => this.logger.warn(message),
    });
  }

  private async waitForCards(page: Page): Promise<void> {
    await page
      .waitForFunction(
        (selector) => document.querySelectorAll(selector).length > 0,
        REDDIT_POST_SELECTOR,
        { timeout: 10_000 },
      )
      .catch(() => undefined);
    await page.waitForTimeout(800);
  }

  private normalizeCard(
    source: RedditPublicSource,
    card: RedditPageCard,
  ): RedditPublicPost | null {
    const rawId = card.id.startsWith('t3_')
      ? card.id
      : card.permalink.match(/\/comments\/([a-z0-9]+)(?:\/|$)/i)?.[1];
    if (!rawId) return null;
    const externalPostId = rawId.startsWith('t3_') ? rawId : `t3_${rawId}`;
    const postedAt = card.createdAt ? new Date(card.createdAt) : new Date();

    return {
      externalPostId,
      canonicalUrl: card.permalink,
      subreddit: card.subreddit ?? source.subreddit ?? 'unknown',
      authorUsername: card.author ?? null,
      title: card.title,
      body: card.body ?? '',
      score: card.score ?? 0,
      commentCount: card.commentCount ?? 0,
      postedAt: Number.isNaN(postedAt.getTime()) ? new Date() : postedAt,
      mediaUrls: card.mediaUrls,
      topComments: [],
      detailFetched: false,
    };
  }

  private async persist(
    source: RedditPublicSource,
    record: RedditPublicPost,
  ): Promise<boolean> {
    const post = await this.prisma.redditPost.upsert({
      where: { externalPostId: record.externalPostId },
      update: {
        subreddit: record.subreddit,
        authorUsername: record.authorUsername,
        title: record.title,
        body: record.body,
        permalink: record.canonicalUrl,
        score: record.score,
        commentCount: record.commentCount,
      },
      create: {
        externalPostId: record.externalPostId,
        subreddit: record.subreddit,
        authorUsername: record.authorUsername,
        title: record.title,
        body: record.body,
        permalink: record.canonicalUrl,
        score: record.score,
        commentCount: record.commentCount,
        postedAt: record.postedAt,
      },
    });

    await this.prisma.$executeRaw`
      UPDATE "RedditPost"
      SET
        "mediaUrls"=${JSON.stringify(record.mediaUrls)}::jsonb,
        "topComments"=${JSON.stringify(record.topComments)}::jsonb,
        "detailFetchedAt"=${record.detailFetched ? new Date() : null}
      WHERE id=${post.id}::uuid
    `;

    const key = {
      workspaceId: source.workspaceId,
      postId: post.id,
      sourceId: source.id,
    };
    const existing = await this.prisma.postDiscovery.findUnique({
      where: { workspaceId_postId_sourceId: key },
      select: { id: true },
    });
    await this.prisma.postDiscovery.upsert({
      where: { workspaceId_postId_sourceId: key },
      update: { discoveredAt: new Date() },
      create: key,
    });
    if (existing) return false;
    await this.queue.enqueueClassification(source.workspaceId, post.id);
    return true;
  }
}
