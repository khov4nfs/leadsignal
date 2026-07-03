import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  findWorkspaceRoot,
  resolveRedditRuntimePath,
} from '../../src/reddit-public/reddit-runtime-path';

test('finds the same monorepo root from API and worker package directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'leadsignal-runtime-'));
  const apiDirectory = join(root, 'apps', 'api');
  const workerDirectory = join(root, 'apps', 'worker');
  await Promise.all([
    mkdir(apiDirectory, { recursive: true }),
    mkdir(workerDirectory, { recursive: true }),
    writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n'),
  ]);

  assert.equal(findWorkspaceRoot(apiDirectory), root);
  assert.equal(findWorkspaceRoot(workerDirectory), root);
});

test('resolves relative Reddit runtime files from the monorepo root', () => {
  const root = findWorkspaceRoot();
  assert.equal(
    resolveRedditRuntimePath(undefined, '.runtime/reddit-session.json'),
    resolve(root, '.runtime/reddit-session.json'),
  );
});

test('preserves explicitly configured absolute runtime paths', () => {
  const absolute = resolve(tmpdir(), 'reddit-session.json');
  assert.equal(
    resolveRedditRuntimePath(absolute, '.runtime/reddit-session.json'),
    absolute,
  );
});
