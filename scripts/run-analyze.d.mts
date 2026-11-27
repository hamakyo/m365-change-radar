import type { Writable } from 'node:stream';

/**
 * Dependencies touched at the wrapper's process boundary. Tests inject a
 * compiler entrypoint and collector streams through `runAnalyzeProcess()`;
 * the executable entry keeps the production defaults. No CLI option, flag,
 * or environment variable is involved.
 */
export type AnalyzeProcessIo = {
  /** Repository root containing `tsconfig.corpus.json` and `corpus/`. */
  projectRoot: string;
  /**
   * Injectable compiler module entrypoint used only by tests to simulate
   * compile failures; production always uses the repository-local tsc.
   */
  compilerEntrypoint?: string;
  /** Collector standing in for process.stdout (defaults to it). */
  stdout?: Writable;
  /** Collector standing in for process.stderr (defaults to it). */
  stderr?: Writable;
};

/**
 * Compile the analyze command module into a fresh temporary directory under
 * node:os tmpdir(), run it once, forward its stdout/stderr strings to the
 * injected streams (or the real ones), and return the final exit code.
 * Never leaves temporary files inside the repository, and keeps the CLI's
 * stdout empty on every failure path.
 */
export declare function runAnalyzeProcess(
  io: AnalyzeProcessIo,
): Promise<number>;
