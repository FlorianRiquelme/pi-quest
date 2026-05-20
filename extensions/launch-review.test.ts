import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fs, vol } from 'memfs';
import * as path from 'node:path';
import {
  parseFrontmatter,
  serializeFrontmatter,
  readPlanFrontmatter,
  writePlanFrontmatter,
  recordLaunchReviewSignOff,
  evaluateLaunchGate,
  type PlanFrontmatter,
} from './launch-review';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { default: fs, ...fs };
});

describe('launch-review skill (M2-1)', () => {
  it('SKILL.md exists and declares the quest-launch-review name', async () => {
    // Use the real fs (un-mocked via vi.importActual) since this is a static
    // package asset that ships next to the skill.
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const skillPath = path.resolve(__dirname, '..', 'skills', 'launch-review', 'SKILL.md');
    expect(realFs.existsSync(skillPath)).toBe(true);
    const content = realFs.readFileSync(skillPath, 'utf-8');
    expect(content).toContain('name: quest-launch-review');
    expect(content).toContain('Trust Trinity');
    expect(content).toContain('signed_off_at');
  });
});

describe('parseFrontmatter / serializeFrontmatter', () => {
  it('returns empty frontmatter when document has none', () => {
    const { frontmatter, body } = parseFrontmatter('# Hello\n\nbody');
    expect(frontmatter).toEqual({});
    expect(body).toBe('# Hello\n\nbody');
  });

  it('parses simple key/value frontmatter', () => {
    const doc = '---\nfoo: bar\n---\n# Body\n';
    const { frontmatter, body } = parseFrontmatter(doc);
    expect(frontmatter.foo).toBe('bar');
    expect(body).toBe('# Body\n');
  });

  it('parses nested object frontmatter', () => {
    const doc =
      '---\n' +
      'blast_radius:\n' +
      '  in_scope:\n' +
      '    - src/foo.ts\n' +
      '  locked_out: []\n' +
      'launch_review:\n' +
      '  signed_off_at: "2026-05-20T11:30:00Z"\n' +
      '  signed_off_by: user\n' +
      '---\n\nbody\n';
    const { frontmatter } = parseFrontmatter(doc);
    expect(frontmatter.blast_radius).toBeDefined();
    expect((frontmatter.blast_radius as Record<string, unknown>).in_scope).toEqual([
      'src/foo.ts',
    ]);
    expect((frontmatter.launch_review as Record<string, unknown>).signed_off_at).toBe(
      '2026-05-20T11:30:00Z',
    );
  });

  it('serializes a doc round-trip preserving body', () => {
    const fm: PlanFrontmatter = {
      blast_radius: { in_scope: ['a.ts'], locked_out: [] },
      launch_review: { signed_off_at: '2026-05-20T11:30:00Z', signed_off_by: 'user' },
    };
    const out = serializeFrontmatter(fm, '# Plan\n');
    expect(out.startsWith('---\n')).toBe(true);
    expect(out.includes('blast_radius:')).toBe(true);
    expect(out.includes('signed_off_at:')).toBe(true);
    expect(out.endsWith('# Plan\n')).toBe(true);

    // Round-trip
    const reparsed = parseFrontmatter(out);
    expect(
      (reparsed.frontmatter.launch_review as Record<string, unknown>).signed_off_at,
    ).toBe('2026-05-20T11:30:00Z');
  });

  it('parses compact-list frontmatter (already-serialized round-trip)', () => {
    // Compact inline-list emitted by serializeFrontmatter must round-trip.
    const fm: PlanFrontmatter = {
      compiler_diagnostics: [],
      pre_mortem: { most_likely_failure: 'oops' },
    };
    const out = serializeFrontmatter(fm, 'body\n');
    const reparsed = parseFrontmatter(out);
    expect(reparsed.frontmatter.compiler_diagnostics).toEqual([]);
    expect(
      (reparsed.frontmatter.pre_mortem as Record<string, unknown>).most_likely_failure,
    ).toBe('oops');
  });
});

describe('readPlanFrontmatter / writePlanFrontmatter', () => {
  beforeEach(() => {
    vol.reset();
  });

  it('returns empty when plan file is missing', () => {
    expect(readPlanFrontmatter('/missing/IMPLEMENTATION_PLAN.md')).toEqual({});
  });

  it('returns empty when plan file has no frontmatter', () => {
    vol.fromJSON({ '/q/IMPLEMENTATION_PLAN.md': '# Plan\nbody' });
    expect(readPlanFrontmatter('/q/IMPLEMENTATION_PLAN.md')).toEqual({});
  });

  it('writes frontmatter while preserving body and creates file when missing', () => {
    writePlanFrontmatter('/q/IMPLEMENTATION_PLAN.md', { blast_radius: { in_scope: ['x'] } });
    const written = fs.readFileSync('/q/IMPLEMENTATION_PLAN.md', 'utf-8') as string;
    expect(written).toContain('blast_radius:');
    expect(written).toContain('in_scope:');
  });

  it('merges into existing frontmatter without dropping other keys', () => {
    vol.fromJSON({
      '/q/IMPLEMENTATION_PLAN.md':
        '---\nblast_radius:\n  in_scope:\n    - a.ts\n---\n\n# Plan\n',
    });
    writePlanFrontmatter('/q/IMPLEMENTATION_PLAN.md', {
      launch_review: { signed_off_at: '2026-05-20T11:30:00Z', signed_off_by: 'user' },
    });
    const fm = readPlanFrontmatter('/q/IMPLEMENTATION_PLAN.md');
    expect((fm.blast_radius as Record<string, unknown>).in_scope).toEqual(['a.ts']);
    expect((fm.launch_review as Record<string, unknown>).signed_off_at).toBe(
      '2026-05-20T11:30:00Z',
    );
  });
});

describe('recordLaunchReviewSignOff', () => {
  beforeEach(() => {
    vol.reset();
  });

  it('writes signed_off_at + signed_off_by to plan frontmatter', () => {
    vol.fromJSON({ '/q/IMPLEMENTATION_PLAN.md': '# Plan\n' });
    const ts = recordLaunchReviewSignOff('/q/IMPLEMENTATION_PLAN.md');
    const fm = readPlanFrontmatter('/q/IMPLEMENTATION_PLAN.md');
    const lr = fm.launch_review as Record<string, unknown>;
    expect(lr.signed_off_by).toBe('user');
    expect(lr.signed_off_at).toBe(ts);
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe('evaluateLaunchGate', () => {
  it('passes when all four conditions are met', () => {
    const fm: PlanFrontmatter = {
      blast_radius: { in_scope: ['a.ts'] },
      pre_mortem: { most_likely_failure: 'x' },
      compiler_diagnostics: [],
      launch_review: { signed_off_at: '2026-05-20T11:30:00Z', signed_off_by: 'user' },
    };
    const result = evaluateLaunchGate(fm);
    expect(result.outcome).toBe('passed');
    expect(result.reasons).toEqual([]);
  });

  it('passes when compiler_diagnostics is missing entirely (empty list passes)', () => {
    const fm: PlanFrontmatter = {
      blast_radius: { in_scope: ['a'] },
      pre_mortem: { most_likely_failure: 'x' },
      launch_review: { signed_off_at: '2026-05-20T11:30:00Z', signed_off_by: 'user' },
    };
    const result = evaluateLaunchGate(fm);
    expect(result.outcome).toBe('passed');
  });

  it('blocks when blast_radius missing', () => {
    const fm: PlanFrontmatter = {
      pre_mortem: { most_likely_failure: 'x' },
      launch_review: { signed_off_at: '2026-05-20T11:30:00Z', signed_off_by: 'user' },
    };
    const result = evaluateLaunchGate(fm);
    expect(result.outcome).toBe('blocked');
    expect(result.reasons).toContain('missing_blast_radius');
  });

  it('blocks when pre_mortem missing', () => {
    const fm: PlanFrontmatter = {
      blast_radius: { in_scope: ['a'] },
      launch_review: { signed_off_at: '2026-05-20T11:30:00Z', signed_off_by: 'user' },
    };
    const result = evaluateLaunchGate(fm);
    expect(result.outcome).toBe('blocked');
    expect(result.reasons).toContain('missing_pre_mortem');
  });

  it('blocks when compiler_diagnostics contains a severity:error entry', () => {
    const fm: PlanFrontmatter = {
      blast_radius: { in_scope: ['a'] },
      pre_mortem: { most_likely_failure: 'x' },
      compiler_diagnostics: [
        { severity: 'warning', rule: 'WP-01' },
        { severity: 'error', rule: 'WP-02:missing_acceptance' },
      ],
      launch_review: { signed_off_at: '2026-05-20T11:30:00Z', signed_off_by: 'user' },
    };
    const result = evaluateLaunchGate(fm);
    expect(result.outcome).toBe('blocked');
    expect(result.reasons).toContain('compiler_error: WP-02:missing_acceptance');
  });

  it('blocks when sign-off missing', () => {
    const fm: PlanFrontmatter = {
      blast_radius: { in_scope: ['a'] },
      pre_mortem: { most_likely_failure: 'x' },
    };
    const result = evaluateLaunchGate(fm);
    expect(result.outcome).toBe('blocked');
    expect(result.reasons).toContain('missing_sign_off');
  });

  it('returns all applicable reasons in subset', () => {
    const fm: PlanFrontmatter = {};
    const result = evaluateLaunchGate(fm);
    expect(result.outcome).toBe('blocked');
    expect(result.reasons).toContain('missing_blast_radius');
    expect(result.reasons).toContain('missing_pre_mortem');
    expect(result.reasons).toContain('missing_sign_off');
  });

  it('treats empty blast_radius value as missing', () => {
    const fm: PlanFrontmatter = {
      blast_radius: null,
      pre_mortem: { most_likely_failure: 'x' },
      launch_review: { signed_off_at: '2026-05-20T11:30:00Z', signed_off_by: 'user' },
    };
    const result = evaluateLaunchGate(fm);
    expect(result.outcome).toBe('blocked');
    expect(result.reasons).toContain('missing_blast_radius');
  });
});
