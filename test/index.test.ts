import { describe, expect, it } from 'vitest';

import { foundationHealth } from '../src/index.js';

describe('repository foundation', () => {
  it('exposes a working TypeScript test surface', () => {
    expect(foundationHealth()).toBe('ok');
  });
});
