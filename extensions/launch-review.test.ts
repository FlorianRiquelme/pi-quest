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
  recordPreMortemEdit,
  recordAcknowledgedWarning,
  resolveActiveQuestPlanPath,
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

describe('launch-review skill (M2-2 content)', () => {
  it('SKILL.md replaces M2-1 placeholders with real Trinity rendering', async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const skillPath = path.resolve(__dirname, '..', 'skills', 'launch-review', 'SKILL.md');
    const content = realFs.readFileSync(skillPath, 'utf-8');
    // M2-1 placeholders must be gone.
    expect(content).not.toContain('M2-1 placeholder');
    expect(content).not.toContain('will appear here in M2-2');
    // Real rendering instructions must be present.
    expect(content).toMatch(/compiler_diagnostics/);
    expect(content).toMatch(/blast_radius/);
    expect(content).toMatch(/pre_mortem/);
    // Mentions warnings are acknowledgeable, errors block.
    expect(content).toMatch(/acknowledg/i);
    // Mentions the in-place pre-mortem edit flow + edits ledger.
    expect(content).toContain('pre_mortem_edits');
    // Mentions the helpers the skill uses.
    expect(content).toMatch(/recordLaunchReviewSignOff|recordPreMortemEdit|recordAcknowledgedWarning/);
  });
});

describe('planning agent prompt (M2-2)', () => {
  it('agents/planning.md requires blast_radius (in_scope aggregated from claims, locked_out planner-declared)', async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const path_ = await vi.importActual<typeof import('node:path')>('node:path');
    const promptPath = path_.resolve(__dirname, '..', 'agents', 'planning.md');
    const content = realFs.readFileSync(promptPath, 'utf-8');
    expect(content).toContain('blast_radius');
    expect(content).toContain('in_scope');
    expect(content).toContain('locked_out');
    expect(content).toMatch(/aggregate/i);
    expect(content).toContain('claims');
  });

  it('agents/planning.md requires pre_mortem with the three singular keys', async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const path_ = await vi.importActual<typeof import('node:path')>('node:path');
    const promptPath = path_.resolve(__dirname, '..', 'agents', 'planning.md');
    const content = realFs.readFileSync(promptPath, 'utf-8');
    expect(content).toContain('pre_mortem');
    expect(content).toContain('most_likely_failure');
    expect(content).toContain('detection_signal');
    expect(content).toContain('recovery_plan');
  });
});

describe('review-discussion agent prompt (M2-2)', () => {
  it('agents/review-discussion.md requires an Acceptance Criteria section with labeled requirements', async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const path_ = await vi.importActual<typeof import('node:path')>('node:path');
    const promptPath = path_.resolve(__dirname, '..', 'agents', 'review-discussion.md');
    const content = realFs.readFileSync(promptPath, 'utf-8');
    expect(content).toContain('Acceptance Criteria');
    // The labeling format `[R<n>]` must be documented.
    expect(content).toMatch(/\[R<n>\]|\[R\\<n\\>\]|\[R1\]/);
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

  it('does NOT block on warnings (only severity:error blocks)', () => {
    const fm: PlanFrontmatter = {
      blast_radius: { in_scope: ['a'] },
      pre_mortem: { most_likely_failure: 'x' },
      compiler_diagnostics: [
        { severity: 'warning', rule: 'empty_claims', message: 'WI-1 has no claims', work_item: 'WI-1' },
        { severity: 'warning', rule: 'missing_verification', message: 'WI-2 has no verification', work_item: 'WI-2' },
      ],
      launch_review: { signed_off_at: '2026-05-20T11:30:00Z', signed_off_by: 'user' },
    };
    const result = evaluateLaunchGate(fm);
    expect(result.outcome).toBe('passed');
    expect(result.reasons).toEqual([]);
  });
});

describe('recordPreMortemEdit', () => {
  beforeEach(() => {
    vol.reset();
  });

  it('updates the pre_mortem text and appends a pre_mortem_edits entry', () => {
    const existing =
      '---\n' +
      'pre_mortem:\n' +
      '  most_likely_failure: "the worst case"\n' +
      '  detection_signal: "noise"\n' +
      '  recovery_plan: "rollback"\n' +
      '---\n\n# Plan\n';
    vol.fromJSON({ '/q/IMPLEMENTATION_PLAN.md': existing });

    recordPreMortemEdit('/q/IMPLEMENTATION_PLAN.md', {
      field: 'most_likely_failure',
      after: 'a sharper worst case',
    });

    const fm = readPlanFrontmatter('/q/IMPLEMENTATION_PLAN.md');
    const pm = fm.pre_mortem as Record<string, unknown>;
    expect(pm.most_likely_failure).toBe('a sharper worst case');
    const edits = fm.pre_mortem_edits as Array<Record<string, unknown>>;
    expect(Array.isArray(edits)).toBe(true);
    expect(edits).toHaveLength(1);
    expect(edits[0].field).toBe('most_likely_failure');
    expect(edits[0].before).toBe('the worst case');
    expect(edits[0].after).toBe('a sharper worst case');
    expect(edits[0].who).toBe('user');
    expect(typeof edits[0].at).toBe('string');
  });

  it('appends successive edits to pre_mortem_edits without clobbering history', () => {
    vol.fromJSON({
      '/q/IMPLEMENTATION_PLAN.md':
        '---\n' +
        'pre_mortem:\n' +
        '  most_likely_failure: "original"\n' +
        '  detection_signal: "old signal"\n' +
        '  recovery_plan: "old plan"\n' +
        '---\n',
    });
    recordPreMortemEdit('/q/IMPLEMENTATION_PLAN.md', { field: 'detection_signal', after: 'new signal' });
    recordPreMortemEdit('/q/IMPLEMENTATION_PLAN.md', { field: 'recovery_plan', after: 'new plan' });
    const fm = readPlanFrontmatter('/q/IMPLEMENTATION_PLAN.md');
    const edits = fm.pre_mortem_edits as Array<Record<string, unknown>>;
    expect(edits).toHaveLength(2);
    expect(edits[0].field).toBe('detection_signal');
    expect(edits[1].field).toBe('recovery_plan');
  });
});

describe('resolveActiveQuestPlanPath (issue #2 — auto-discover active quest)', () => {
  beforeEach(() => {
    vol.reset();
  });

  it('returns the plan path for the active quest from state.json', () => {
    vol.fromJSON({
      '/project/.pi/quest/state.json': JSON.stringify({ currentQuestId: 'q-active' }),
      '/project/.pi/quests/q-active/IMPLEMENTATION_PLAN.md': '# Plan\n',
    });
    const planPath = resolveActiveQuestPlanPath('/project');
    expect(planPath).toBe('/project/.pi/quests/q-active/IMPLEMENTATION_PLAN.md');
  });

  it('uses the workflow.artifacts.plan filename when available', () => {
    vol.fromJSON({
      '/project/.pi/quest/state.json': JSON.stringify({ currentQuestId: 'q1' }),
      '/project/.pi/quests/q1/workflow.json': JSON.stringify({
        id: 'q1',
        title: 't',
        status: 'launch-review',
        createdAt: '',
        updatedAt: '',
        source: {},
        artifacts: { handoff: 'H.md', plan: 'CUSTOM_PLAN.md' },
      }),
      '/project/.pi/quests/q1/CUSTOM_PLAN.md': '# Plan\n',
    });
    expect(resolveActiveQuestPlanPath('/project')).toBe(
      '/project/.pi/quests/q1/CUSTOM_PLAN.md',
    );
  });

  it('throws a "no active quest" error when state.json is missing', () => {
    expect(() => resolveActiveQuestPlanPath('/project')).toThrow(/no active quest/i);
  });

  it('throws a "no active quest" error when currentQuestId is null', () => {
    vol.fromJSON({
      '/project/.pi/quest/state.json': JSON.stringify({ currentQuestId: null }),
    });
    expect(() => resolveActiveQuestPlanPath('/project')).toThrow(/no active quest/i);
  });

  it('throws a "no active quest" error when currentQuestId is absent', () => {
    vol.fromJSON({
      '/project/.pi/quest/state.json': JSON.stringify({}),
    });
    expect(() => resolveActiveQuestPlanPath('/project')).toThrow(/no active quest/i);
  });
});

describe('launch-review skill (issue #2 — auto-discovers active quest)', () => {
  it('SKILL.md instructs reading state.json and does not prompt for quest ID', async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const skillPath = path.resolve(__dirname, '..', 'skills', 'launch-review', 'SKILL.md');
    const content = realFs.readFileSync(skillPath, 'utf-8');

    // Must reference state.json as the source of the active quest.
    expect(content).toMatch(/state\.json/);
    expect(content).toMatch(/currentQuestId/);
    // Must reference the helper that resolves the active plan path.
    expect(content).toContain('resolveActiveQuestPlanPath');
    // Must describe the "no active quest" exit path.
    expect(content).toMatch(/no active quest/i);
    // Must NOT contain the old <quest-id> placeholder in the helper call —
    // the skill should resolve the path itself, not interpolate a prompted ID.
    expect(content).not.toContain('recordLaunchReviewSignOff(".pi/quests/<quest-id>/');
  });
});

describe('recordAcknowledgedWarning', () => {
  beforeEach(() => {
    vol.reset();
  });

  it('records the acknowledged warning under launch_review.acknowledged_warnings', () => {
    vol.fromJSON({ '/q/IMPLEMENTATION_PLAN.md': '# Plan\n' });
    recordAcknowledgedWarning('/q/IMPLEMENTATION_PLAN.md', {
      rule: 'empty_claims',
      work_item: 'WI-3',
    });
    const fm = readPlanFrontmatter('/q/IMPLEMENTATION_PLAN.md');
    const lr = fm.launch_review as Record<string, unknown>;
    const acks = lr.acknowledged_warnings as Array<Record<string, unknown>>;
    expect(Array.isArray(acks)).toBe(true);
    expect(acks).toHaveLength(1);
    expect(acks[0].rule).toBe('empty_claims');
    expect(acks[0].work_item).toBe('WI-3');
    expect(typeof acks[0].acknowledged_at).toBe('string');
  });

  it('accumulates multiple acknowledged warnings', () => {
    vol.fromJSON({ '/q/IMPLEMENTATION_PLAN.md': '# Plan\n' });
    recordAcknowledgedWarning('/q/IMPLEMENTATION_PLAN.md', { rule: 'empty_claims', work_item: 'WI-1' });
    recordAcknowledgedWarning('/q/IMPLEMENTATION_PLAN.md', { rule: 'missing_verification', work_item: 'WI-2' });
    const fm = readPlanFrontmatter('/q/IMPLEMENTATION_PLAN.md');
    const acks = (fm.launch_review as Record<string, unknown>)
      .acknowledged_warnings as Array<Record<string, unknown>>;
    expect(acks).toHaveLength(2);
  });

  it('preserves existing launch_review keys', () => {
    vol.fromJSON({
      '/q/IMPLEMENTATION_PLAN.md':
        '---\n' +
        'launch_review:\n' +
        '  signed_off_at: "2026-05-20T11:30:00Z"\n' +
        '  signed_off_by: user\n' +
        '---\n',
    });
    recordAcknowledgedWarning('/q/IMPLEMENTATION_PLAN.md', {
      rule: 'empty_claims',
      work_item: 'WI-1',
    });
    const fm = readPlanFrontmatter('/q/IMPLEMENTATION_PLAN.md');
    const lr = fm.launch_review as Record<string, unknown>;
    expect(lr.signed_off_at).toBe('2026-05-20T11:30:00Z');
    expect(lr.signed_off_by).toBe('user');
    expect(Array.isArray(lr.acknowledged_warnings)).toBe(true);
  });
});
