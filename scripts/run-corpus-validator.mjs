/* global URL, console, process */

import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temporaryOutput = mkdtempSync(join(projectRoot, '.corpus-dist-'));
const compilerPath = join(
  projectRoot,
  'node_modules',
  'typescript',
  'bin',
  'tsc',
);

let exitCode = 1;

try {
  const compile = spawnSync(
    process.execPath,
    [
      compilerPath,
      '--project',
      join(projectRoot, 'tsconfig.corpus.json'),
      '--outDir',
      temporaryOutput,
    ],
    { cwd: projectRoot, stdio: 'inherit' },
  );

  if (compile.error) {
    console.error(
      `Unable to compile corpus validator: ${compile.error.message}`,
    );
  } else if (compile.status !== 0) {
    exitCode = compile.status ?? 1;
  } else {
    const run = spawnSync(
      process.execPath,
      [join(temporaryOutput, 'scripts', 'validate-corpus.js')],
      { cwd: projectRoot, stdio: 'inherit' },
    );
    exitCode = run.error ? 1 : (run.status ?? 1);
  }
} finally {
  rmSync(temporaryOutput, { recursive: true, force: true });
}

process.exitCode = exitCode;
