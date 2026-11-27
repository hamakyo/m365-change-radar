/* global URL, process */

import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Thin process wrapper around runPhase1ExitGateReportCommand(). All load,
// validate, matrix, join, and report logic lives in the injected-io command
// module; this script only compiles it with the repository-local tsc, writes
// the returned strings to the real stdout/stderr streams, and propagates the
// exit code. It takes no arguments. The CLI's stdout is reserved for the
// final result: nothing but the one-line JSON report ever reaches it —
// compiler diagnostics, compiler chatter, and spawn errors are forwarded to
// stderr instead. Compilation happens into a unique directory under
// node:os tmpdir(), so neither a successful nor a failing run leaves any
// temporary file or directory inside the repository.

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_COMPILER_ENTRYPOINT = join(
  PROJECT_ROOT,
  'node_modules',
  'typescript',
  'bin',
  'tsc',
);

/**
 * Writes text to the injected stream or defaults to process stdout. Empty
 * strings produce no write at all, keeping success output byte-exact.
 *
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
 * Writes text to the injected stream or defaults to process stderr.
 *
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
 * Compile src/corpus/phase-1-exit-gate-report.ts plus its imports into a
 * fresh temporary directory under node:os tmpdir(), then run it and return
 * the resulting exit code.
 *
 * Everything tunable arrives through `io`, so tests can inject a failing
 * compiler entrypoint and collector streams without touching production
 * arguments, options, flags, or environment variables.
 *
 * @param {{
 *   projectRoot: string,
 *   compilerEntrypoint?: string,
 *   stdout?: Writable,
 *   stderr?: Writable,
 * }} io
 * @returns {Promise<number>} final CLI exit code
 */
export async function runPhase1ExitGateReportProcess(io) {
  const projectRoot = io.projectRoot;
  const compilerEntrypoint =
    io.compilerEntrypoint !== undefined
      ? io.compilerEntrypoint
      : DEFAULT_COMPILER_ENTRYPOINT;

  // Never inside the repository: the scratch-free boundary requires that no
  // temporary file or directory appears under projectRoot for ANY outcome.
  const temporaryOutput = mkdtempSync(
    join(tmpdir(), '.phase1-exit-gate-report-dist-'),
  );
  // The temp compile directory now lives outside the repository, so Node's
  // upward node_modules resolution can no longer find dependencies from
  // there. Symlinking the project's real node_modules into the temporary
  // directory keeps imports working; the symlink itself lives only in the
  // OS temp dir and is removed with it. Nothing is written into projectRoot.
  try {
    symlinkSync(
      join(projectRoot, 'node_modules'),
      join(temporaryOutput, 'node_modules'),
      'dir',
    );
  } catch {
    // A missing or unsymlinkable node_modules is surfaced later as a clear
    // runtime failure of the compiled command instead of hiding the cause.
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
        // Compiler chatter is captured (piped), never inherited onto the
        // CLI's streams: the CLI's stdout stays empty on every failure
        // path, and no interleaving noise pollutes stderr ordering.
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    if (compile.error !== undefined && compile.error !== null) {
      writeErr(
        io.stderr,
        `Unable to compile phase1:report CLI: ${compile.error.message}`,
      );
    } else if (compile.status !== 0) {
      // Compiler diagnostics must never reach the CLI's stdout; anything
      // the compiler printed on either child stream is routed to stderr,
      // followed by an explicit one-line summary of the failure.
      if (compile.stdout !== null && compile.stdout.length > 0) {
        writeErr(io.stderr, compile.stdout.toString('utf8'));
      }
      if (compile.stderr !== null && compile.stderr.length > 0) {
        writeErr(io.stderr, compile.stderr.toString('utf8'));
      }
      writeErr(
        io.stderr,
        `Unable to compile phase1:report CLI: compilation failed with exit code ${
          compile.status ?? 'signal'
        }.`,
      );
      exitCode = compile.status ?? 1;
    } else {
      const { runPhase1ExitGateReportCommand } = await import(
        pathToFileURL(
          join(temporaryOutput, 'src', 'corpus', 'phase-1-exit-gate-report.js'),
        )
      );
      const result = await runPhase1ExitGateReportCommand();
      writeErr(io.stderr, result.stderr);
      writeOut(io.stdout, result.stdout);
      exitCode = result.exitCode;
    }
  } catch (error) {
    writeErr(
      io.stderr,
      `Unable to run phase1:report CLI: ${
        error instanceof Error ? error.message : String(error)
      }`,
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
  process.exitCode = await runPhase1ExitGateReportProcess({
    projectRoot: PROJECT_ROOT,
  });
}
