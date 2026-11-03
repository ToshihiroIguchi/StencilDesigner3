import { describe, it, expect, vi, afterEach } from 'vitest';
import { newDocId } from '../../src/state/docStore';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newDocId', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns a v4 UUID when randomUUID is available', () => {
    expect(newDocId()).toMatch(UUID_V4);
  });

  it('falls back to getRandomValues in insecure contexts (plain HTTP over LAN)', () => {
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    const a = newDocId();
    const b = newDocId();
    expect(a).toMatch(UUID_V4);
    expect(a).not.toBe(b);
  });
});
