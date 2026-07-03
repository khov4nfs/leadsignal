import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export function findWorkspaceRoot(startDirectory = process.cwd()): string {
  let current = resolve(startDirectory);

  while (true) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      const initialDirectory = process.env.INIT_CWD?.trim();
      return initialDirectory ? resolve(initialDirectory) : resolve(startDirectory);
    }
    current = parent;
  }
}

export function resolveRedditRuntimePath(
  configuredPath: string | undefined,
  defaultRelativePath: string,
): string {
  const value = configuredPath?.trim() || defaultRelativePath;
  if (isAbsolute(value)) return value;
  return resolve(findWorkspaceRoot(), value);
}
