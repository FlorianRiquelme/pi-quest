import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fs, vol } from 'memfs';
import { resolveReferences } from './references';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { default: fs, ...fs };
});

describe('resolveReferences', () => {
  beforeEach(() => {
    vol.reset();
  });

  it('returns empty string when no markdown links', async () => {
    const result = await resolveReferences('/handoff.md', '# Title\n\nSome text.');
    expect(result).toBe('');
  });

  it('inlines local markdown references', async () => {
    vol.fromJSON({
      '/handoff.md': '# Title',
      '/ref/context.md': '# Context\n\nDetails here.',
    });
    const input = 'See [Context](./ref/context.md) for more.';
    const result = await resolveReferences('/handoff.md', input);
    expect(result).toContain('# Resolved Reference Documents');
    expect(result).toContain('Context');
    expect(result).toContain('Details here.');
  });

  it('skips non-markdown links', async () => {
    const input = 'See [image](./img.png) and [doc](./ref.md).';
    vol.writeFileSync('/ref.md', 'ref content');
    const result = await resolveReferences('/handoff.md', input);
    expect(result).toContain('ref content');
    expect(result).not.toContain('img.png');
  });

  it('marks external links without inlining', async () => {
    const input = 'See [Guide](https://example.com/guide.md).';
    const result = await resolveReferences('/handoff.md', input);
    expect(result).toContain('external link');
    expect(result).toContain('Guide');
  });

  it('ignores missing local files', async () => {
    const input = 'See [Missing](./missing.md).';
    const result = await resolveReferences('/handoff.md', input);
    expect(result).toBe('');
  });
});
