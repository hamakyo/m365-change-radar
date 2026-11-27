/* global URL, process */

import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_COMPILER_ENTRYPOINT = join(
  PROJECT_ROOT,
  'node_modules',
  'typescript',
  'bin',
  'tsc',
);

/**
 * @param {Writable | undefined} stream
 * @param {string} text
 * @returns {void}
 */
function writeOut(stream, text) {
  if (text.length > 0) {
    (stream ?? process.stdout).write(text);
  }
}

/**
 * @param {Writable | undefined} stream
 * @param {string} text
 * @returns {void}
 */
function writeErr(stream, text) {
  if (text.length > 0) {
    (stream ?? process.stderr).write(text);
  }
}

/**
 * Compile `src/digest/digest-cli.ts` into a temporary directory under OS
 * `tmpdir()` and invoke `runDigestCommand(argv)` without leaving scratch build
 * artifacts in the repository root.
 *
 * @param {{
 *   projectRoot: string,
 *   argv?: readonly string[],
 *   compilerEntrypoint?: string,
 *   stdout?: Writable,
 *   stderr?: Writable,
 * }} io
 * @returns {Promise<number>}
 */
export async function runDigestProcess(io) {
  const projectRoot = io.projectRoot;
  const argv = io.argv ?? process.argv.slice(2);
  const compilerEntrypoint =
    io.compilerEntrypoint !== undefined
      ? io.compilerEntrypoint
      : DEFAULT_COMPILER_ENTRYPOINT;

  const temporaryOutput = mkdtempSync(join(tmpdir(), '.digest-dist-'));
  try {
    symlinkSync(
      join(projectRoot, 'node_modules'),
      join(temporaryOutput, 'node_modules'),
      'dir',
    );
  } catch {
    // Missing node_modules is surfaced cleanly when loading compiled modules.
  }

  let exitCode = 1;

  try {
    const compile = spawnSync(
      process.execPath,
      [
        compilerEntrypoint,
        '--project',
        join(projectRoot, 'tsconfig.corpus.json'),
        '--outDir',
        temporaryOutput,
      ],
      {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    if (compile.error !== undefined && compile.error !== null) {
      writeErr(
        io.stderr,
        `Unable to compile digest CLI: ${compile.error.message}\n`,
      );
    } else if (compile.status !== 0) {
      if (compile.stdout !== null && compile.stdout.length > 0) {
        writeErr(io.stderr, compile.stdout.toString('utf8'));
      }
      if (compile.stderr !== null && compile.stderr.length > 0) {
        writeErr(io.stderr, compile.stderr.toString('utf8'));
      }
      writeErr(
        io.stderr,
        `Unable to compile digest CLI: compilation failed with exit code ${
          compile.status ?? 'signal'
        }.\n`,
      );
      exitCode = compile.status ?? 1;
    } else {
      const { runDigestCommand } = await import(
        pathToFileURL(join(temporaryOutput, 'src', 'digest', 'digest-cli.js'))
      );
      const result = await runDigestCommand(argv, {
        resolveProjectRoot: () => projectRoot,
        now: () => new Date().toISOString(),
      });
      writeErr(io.stderr, result.stderr);
      writeOut(io.stdout, result.stdout);
      exitCode = result.exitCode;
    }
  } catch (error) {
    writeErr(
      io.stderr,
      `Unable to run digest CLI: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    exitCode = 1;
  } finally {
    rmSync(temporaryOutput, { recursive: true, force: true });
  }

  return exitCode;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await runDigestProcess({
    projectRoot: PROJECT_ROOT,
  });
}
