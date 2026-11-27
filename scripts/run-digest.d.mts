import type { Writable } from 'node:stream';

export function runDigestProcess(io: {
  projectRoot: string;
  argv?: readonly string[];
  compilerEntrypoint?: string;
  stdout?: Writable;
  stderr?: Writable;
}): Promise<number>;
