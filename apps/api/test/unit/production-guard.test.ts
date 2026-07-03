import assert from 'node:assert/strict';
import test from 'node:test';
import { UnauthorizedException } from '@nestjs/common';
import {
  isPublicProductionRoute,
  ProductionAuthGuard,
} from '../../src/production/production.guard';

test('allows only the intended unauthenticated extension handshake routes', () => {
  assert.equal(isPublicProductionRoute('POST', '/api/auth/extension/pair'), true);
  assert.equal(isPublicProductionRoute('POST', '/api/auth/extension/challenge'), true);
  assert.equal(isPublicProductionRoute('POST', '/api/auth/extension/verify'), true);
  assert.equal(isPublicProductionRoute('POST', '/api/auth/extension/exchange'), true);
  assert.equal(isPublicProductionRoute('POST', '/api/extension/ingest'), true);
  assert.equal(isPublicProductionRoute('POST', '/api/extension/source-settings'), true);
});

test('does not make future extension endpoints public by prefix', () => {
  assert.equal(isPublicProductionRoute('GET', '/api/auth/extension/devices'), false);
  assert.equal(isPublicProductionRoute('POST', '/api/auth/extension/revoke-all'), false);
  assert.equal(isPublicProductionRoute('GET', '/api/extension/ingest'), false);
  assert.equal(isPublicProductionRoute('GET', '/api/extension/source-settings'), false);
  assert.equal(
    isPublicProductionRoute('POST', '/api/auth/extension/reddit-session'),
    false,
  );
});

test('allows Reddit session sync only when a one-time extension ticket is supplied', async () => {
  const guard = new ProductionAuthGuard({} as never);
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'POST',
        url: '/api/auth/extension/reddit-session',
        body: { ticket: 'short-lived-ticket' },
        headers: {},
      }),
    }),
  } as never;

  assert.equal(await guard.canActivate(context), true);
});

test('still requires bearer authentication when Reddit sync ticket is missing', async () => {
  const guard = new ProductionAuthGuard({} as never);
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'POST',
        url: '/api/auth/extension/reddit-session',
        body: {},
        headers: {},
      }),
    }),
  } as never;

  await assert.rejects(
    () => guard.canActivate(context),
    (error: unknown) =>
      error instanceof UnauthorizedException &&
      error.message === 'Bearer access token is required',
  );
});

test('ignores query strings while matching public routes', () => {
  assert.equal(
    isPublicProductionRoute('POST', '/api/auth/extension/challenge?debug=false'),
    true,
  );
});
