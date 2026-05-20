import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fs, vol } from 'memfs';
import { iterateOnFailures } from './uat-failure-loop';
import { parseUatScenarios } from './uat-scenarios';
import { readPlanFrontmatter } from './launch-review';
import type { UatScenario } from './uat-scenarios';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { default: fs, ...fs };
});

const failedScenario = (overrides: Partial<UatScenario> = {}): UatScenario => ({
  id: 'S1',
  name: 'User can log in',
  setup: [],
  actions: ['Open: /login', 'Click: submit'],
  verify: ['Redirected to /dashboard with the user email visible'],
  verdict: 'fail',
  notes: 'redirect never fires',
  ...overrides,
});

describe('iterateOnFailures', () => {
  beforeEach(() => {
    vol.reset();
  });

  const seedPlanAndUat = () => {
    vol.fromJSON({
      '/q/IMPLEMENTATION_PLAN.md': [
        '---',
        'work_items:',
        '  - id: WI-1',
        '    acceptance: "auth works"',
        '    verification: "bun test"',
        '    claims:',
        '      - src/auth.ts',
        '    depends_on: []',
        '    addresses:',
        '      - R1',
        '---',
        '',
        '# Plan',
        '',
        'body kept',
      ].join('\n'),
      '/q/UAT.md': [
        '---',
        'uat_scenarios:',
        '  - id: S1',
        '    name: "User can log in"',
        '    setup: []',
        '    actions:',
        '      - "Open: /login"',
        '    verify:',
        '      - "Redirected to /dashboard"',
        '    verdict: fail',
        '    notes: "redirect missing"',
        '---',
        '',
        '# UAT',
      ].join('\n'),
    });
  };

  it('drafts a work-item per failed scenario with name + acceptance + verification', () => {
    seedPlanAndUat();
    const result = iterateOnFailures({
      questId: 'q1',
      failedScenarios: [failedScenario()],
      planPath: '/q/IMPLEMENTATION_PLAN.md',
      uatPath: '/q/UAT.md',
    });

    expect(result.newWorkItems).toHaveLength(1);
    const wi = result.newWorkItems[0];
    expect(wi.id).toMatch(/^WI-/);
    expect(wi.name).toBe('User can log in (UAT fix)');
    expect(wi.acceptance).toEqual([
      'Redirected to /dashboard with the user email visible',
    ]);
    expect(wi.verification).toEqual(['Open: /login', 'Click: submit']);
    expect(wi.claims).toEqual([]);
  });

  it('appends drafted work items to plan frontmatter, preserves existing items', () => {
    seedPlanAndUat();
    iterateOnFailures({
      questId: 'q1',
      failedScenarios: [failedScenario()],
      planPath: '/q/IMPLEMENTATION_PLAN.md',
      uatPath: '/q/UAT.md',
    });

    const fm = readPlanFrontmatter('/q/IMPLEMENTATION_PLAN.md');
    const workItems = fm.work_items as Array<Record<string, unknown>>;
    expect(workItems).toHaveLength(2);
    expect(workItems[0].id).toBe('WI-1');
    expect(workItems[1].name).toBe('User can log in (UAT fix)');
  });

  it('reports planUpdated: true when work-items are appended', () => {
    seedPlanAndUat();
    const result = iterateOnFailures({
      questId: 'q1',
      failedScenarios: [failedScenario()],
      planPath: '/q/IMPLEMENTATION_PLAN.md',
      uatPath: '/q/UAT.md',
    });
    expect(result.planUpdated).toBe(true);
  });

  it('preserves plan markdown body below frontmatter', () => {
    seedPlanAndUat();
    iterateOnFailures({
      questId: 'q1',
      failedScenarios: [failedScenario()],
      planPath: '/q/IMPLEMENTATION_PLAN.md',
      uatPath: '/q/UAT.md',
    });
    const text = fs.readFileSync('/q/IMPLEMENTATION_PLAN.md', 'utf-8') as string;
    expect(text).toContain('# Plan');
    expect(text).toContain('body kept');
  });

  it('resets the failed scenarios in UAT.md back to pending for retesting', () => {
    seedPlanAndUat();
    iterateOnFailures({
      questId: 'q1',
      failedScenarios: [failedScenario()],
      planPath: '/q/IMPLEMENTATION_PLAN.md',
      uatPath: '/q/UAT.md',
    });
    const after = parseUatScenarios(fs.readFileSync('/q/UAT.md', 'utf-8') as string);
    const s1 = after.find((s) => s.id === 'S1');
    expect(s1?.verdict).toBe('pending');
    expect(s1?.notes).toBe('');
  });

  it('generates unique IDs when multiple failures are iterated together', () => {
    seedPlanAndUat();
    const result = iterateOnFailures({
      questId: 'q1',
      failedScenarios: [
        failedScenario({ id: 'S1' }),
        failedScenario({ id: 'S2', name: 'User can log out' }),
      ],
      planPath: '/q/IMPLEMENTATION_PLAN.md',
      uatPath: '/q/UAT.md',
    });
    const ids = result.newWorkItems.map((wi) => wi.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Should not collide with the existing WI-1.
    expect(ids).not.toContain('WI-1');
  });

  it('returns planUpdated: false (no-op) when failedScenarios is empty', () => {
    seedPlanAndUat();
    const before = fs.readFileSync('/q/IMPLEMENTATION_PLAN.md', 'utf-8') as string;
    const result = iterateOnFailures({
      questId: 'q1',
      failedScenarios: [],
      planPath: '/q/IMPLEMENTATION_PLAN.md',
      uatPath: '/q/UAT.md',
    });
    expect(result.newWorkItems).toEqual([]);
    expect(result.planUpdated).toBe(false);
    const after = fs.readFileSync('/q/IMPLEMENTATION_PLAN.md', 'utf-8') as string;
    expect(after).toBe(before);
  });
});
