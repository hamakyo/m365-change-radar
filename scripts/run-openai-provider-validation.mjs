/* global URL, process */

import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const COMPILER_ENTRYPOINT = join(
  PROJECT_ROOT,
  'node_modules',
  'typescript',
  'bin',
  'tsc',
);

function write(stream, value) {
  if (value.length > 0) stream.write(value);
}

export async function runOpenAIProviderValidationProcess(io) {
  const projectRoot = io.projectRoot;
  const temporaryOutput = mkdtempSync(
    join(tmpdir(), '.openai-provider-validation-dist-'),
  );
  try {
    try {
      symlinkSync(
        join(projectRoot, 'node_modules'),
        join(temporaryOutput, 'node_modules'),
        'dir',
      );
    } catch {
      // The compiled command will surface a missing dependency clearly.
    }

    const compile = spawnSync(
      process.execPath,
      [
        io.compilerEntrypoint ?? COMPILER_ENTRYPOINT,
        '--project',
        join(projectRoot, 'tsconfig.corpus.json'),
        '--outDir',
        temporaryOutput,
      ],
      { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (compile.error !== undefined) {
      write(
        io.stderr,
        `Unable to compile provider validation: ${compile.error.message}\n`,
      );
      return 1;
    }
    if (compile.status !== 0) {
      write(io.stderr, compile.stdout?.toString('utf8') ?? '');
      write(io.stderr, compile.stderr?.toString('utf8') ?? '');
      write(
        io.stderr,
        `Unable to compile provider validation: compilation failed with exit code ${compile.status ?? 'signal'}.\n`,
      );
      return compile.status ?? 1;
    }

    const { runOpenAIProviderValidationCommand } = await import(
      pathToFileURL(
        join(temporaryOutput, 'src', 'corpus', 'openai-provider-validation.js'),
      )
    );
    const result = await runOpenAIProviderValidationCommand({
      apiKey: io.apiKey,
      resolveProjectRoot: () => projectRoot,
    });
    write(io.stderr, result.stderr);
    write(io.stdout, result.stdout);
    return result.exitCode;
  } catch (error) {
    write(
      io.stderr,
      `Unable to run provider validation: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  } finally {
    rmSync(temporaryOutput, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await runOpenAIProviderValidationProcess({
    projectRoot: PROJECT_ROOT,
    apiKey: process.env.OPENAI_API_KEY,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
