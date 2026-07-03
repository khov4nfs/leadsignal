import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { verifyAccessToken } from './security';

const PUBLIC_EXTENSION_ROUTES = new Set([
  'POST /api/auth/extension/pair',
  'POST /api/auth/extension/challenge',
  'POST /api/auth/extension/verify',
  'POST /api/auth/extension/exchange',
  'POST /api/extension/ingest',
  'POST /api/extension/source-settings',
]);

export function isPublicProductionRoute(method: string, path: string): boolean {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = path.split('?')[0];

  if (PUBLIC_EXTENSION_ROUTES.has(`${normalizedMethod} ${normalizedPath}`)) {
    return true;
  }

  return /^\/api\/(health|auth\/(register|login|refresh)|connections\/[^/]+\/complete)$/.test(
    normalizedPath,
  );
}

function isExtensionTicketRoute(request: any): boolean {
  const path = request.url?.split('?')[0] ?? '';
  const method = String(request.method ?? 'GET').toUpperCase();
  return (
    method === 'POST' &&
    path === '/api/auth/extension/reddit-session' &&
    typeof request.body?.ticket === 'string' &&
    request.body.ticket.length > 0
  );
}

@Injectable()
export class ProductionAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<any>();
    const path = request.url?.split('?')[0] ?? '';
    const method = request.method ?? 'GET';

    if (isPublicProductionRoute(method, path)) return true;

    // Reddit session synchronization is authenticated by a short-lived,
    // single-use extension ticket. The endpoint service validates and consumes
    // the ticket before accepting any browser session data.
    if (isExtensionTicketRoute(request)) return true;

    const authorization = request.headers?.authorization as string | undefined;
    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer access token is required');
    }

    let claims;
    try {
      claims = verifyAccessToken(authorization.slice(7));
    } catch (error) {
      throw new UnauthorizedException(
        error instanceof Error ? error.message : 'Invalid access token',
      );
    }

    const sessions = await this.prisma.$queryRaw<
      { revokedAt: Date | null; expiresAt: Date }[]
    >`SELECT "revokedAt","expiresAt" FROM "AuthSession" WHERE id=${claims.sid}::uuid AND "userId"=${claims.sub}::uuid LIMIT 1`;
    const session = sessions[0];
    if (!session || session.revokedAt || new Date(session.expiresAt) <= new Date()) {
      throw new UnauthorizedException('Session is no longer active');
    }

    request.user = claims;
    request.headers['x-user-id'] = claims.sub;
    const workspaceId = request.params?.workspaceId ?? request.query?.workspaceId;
    if (workspaceId) {
      const membership = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "WorkspaceMember"
        WHERE "workspaceId"=${workspaceId}::uuid AND "userId"=${claims.sub}::uuid
        LIMIT 1
      `;
      if (!membership.length) {
        throw new ForbiddenException('You are not a member of this workspace');
      }
      request.headers['x-workspace-id'] = workspaceId;
    }
    return true;
  }
}
