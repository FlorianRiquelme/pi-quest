import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fs, vol } from 'memfs';
import {
  compileHandoff,
  writeDiagnosticsToPlanFrontmatter,
  checkLockedOutWrites,
  type CompilerDiagnostic,
} from './handoff-compiler';
import { readPlanFrontmatter } from './launch-review';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { default: fs, ...fs };
});

/* ================================ Compiler rules ================================ */

describe('compileHandoff — seven rules', () => {
  const minimalResolvedHandoff = (criteria: string[]): string =>
    '# Resolved Handoff\n\n## Acceptance Criteria\n\n' +
    criteria.map((c) => `- ${c}`).join('\n') +
    '\n';

  const planWithWorkItems = (items: Array<Record<string, unknown>>): string => {
    const lines: string[] = ['---', 'work_items:'];
    for (const item of items) {
      lines.push(`  - id: ${item.id}`);
      if ('acceptance' in item && item.acceptance !== undefined) {
        if (Array.isArray(item.acceptance)) {
          lines.push('    acceptance:');
          for (const a of item.acceptance) lines.push(`      - ${a}`);
        } else {
          lines.push(`    acceptance: ${item.acceptance}`);
        }
      }
      if ('verification' in item && item.verification !== undefined) {
        lines.push(`    verification: ${item.verification}`);
      }
      if ('claims' in item) {
        if (Array.isArray(item.claims) && item.claims.length === 0) {
          lines.push('    claims: []');
        } else if (Array.isArray(item.claims)) {
          lines.push('    claims:');
          for (const c of item.claims) lines.push(`      - ${c}`);
        }
      }
      if ('depends_on' in item) {
        if (Array.isArray(item.depends_on) && item.depends_on.length === 0) {
          lines.push('    depends_on: []');
        } else if (Array.isArray(item.depends_on)) {
          lines.push('    depends_on:');
          for (const d of item.depends_on) lines.push(`      - ${d}`);
        }
      }
      if ('addresses' in item) {
        if (Array.isArray(item.addresses) && item.addresses.length === 0) {
          lines.push('    addresses: []');
        } else if (Array.isArray(item.addresses)) {
          lines.push('    addresses:');
          for (const a of item.addresses) lines.push(`      - ${a}`);
        }
      }
    }
    lines.push('---');
    lines.push('');
    lines.push('# Plan');
    return lines.join('\n');
  };

  it('produces no diagnostics for a clean plan + handoff pair', () => {
    const plan = planWithWorkItems([
      {
        id: 'WI-1',
        acceptance: 'works',
        verification: 'bun test',
        claims: ['src/foo.ts'],
        depends_on: [],
        addresses: ['R1'],
      },
    ]);
    const handoff = minimalResolvedHandoff(['[R1] users can sign in']);
    const diagnostics = compileHandoff({ planMarkdown: plan, resolvedHandoffMarkdown: handoff });
    expect(diagnostics).toEqual([]);
  });

  it('rule unaddressed_requirement: handoff requirement not addressed by any work-item', () => {
    const plan = planWithWorkItems([
      {
        id: 'WI-1',
        acceptance: 'a',
        verification: 'v',
        claims: ['src/x.ts'],
        depends_on: [],
        addresses: ['R1'],
      },
    ]);
    const handoff = minimalResolvedHandoff([
      '[R1] sign-in works',
      '[R2] logout works',
    ]);
    const diagnostics = compileHandoff({ planMarkdown: plan, resolvedHandoffMarkdown: handoff });
    const unaddressed = diagnostics.filter((d) => d.rule === 'unaddressed_requirement');
    expect(unaddressed).toHaveLength(1);
    expect(unaddressed[0].severity).toBe('error');
    expect(unaddressed[0].message).toContain('R2');
  });

  it('rule unknown_dependency: depends_on references an unknown work-item ID', () => {
    const plan = planWithWorkItems([
      {
        id: 'WI-1',
        acceptance: 'a',
        verification: 'v',
        claims: ['src/x.ts'],
        depends_on: ['WI-99'],
        addresses: ['R1'],
      },
    ]);
    const handoff = minimalResolvedHandoff(['[R1] does the thing']);
    const diagnostics = compileHandoff({ planMarkdown: plan, resolvedHandoffMarkdown: handoff });
    const unknown = diagnostics.filter((d) => d.rule === 'unknown_dependency');
    expect(unknown).toHaveLength(1);
    expect(unknown[0].severity).toBe('error');
    expect(unknown[0].work_item).toBe('WI-1');
    expect(unknown[0].message).toContain('WI-99');
  });

  it('rule cyclic_dependencies: depends_on graph forms a cycle', () => {
    const plan = planWithWorkItems([
      {
        id: 'WI-1',
        acceptance: 'a',
        verification: 'v',
        claims: ['src/a.ts'],
        depends_on: ['WI-2'],
        addresses: ['R1'],
      },
      {
        id: 'WI-2',
        acceptance: 'a',
        verification: 'v',
        claims: ['src/b.ts'],
        depends_on: ['WI-1'],
        addresses: [],
      },
    ]);
    const handoff = minimalResolvedHandoff(['[R1] does the thing']);
    const diagnostics = compileHandoff({ planMarkdown: plan, resolvedHandoffMarkdown: handoff });
    const cyclic = diagnostics.filter((d) => d.rule === 'cyclic_dependencies');
    expect(cyclic.length).toBeGreaterThan(0);
    expect(cyclic[0].severity).toBe('error');
  });

  it('rule missing_acceptance_criteria: work-item without an acceptance field', () => {
    const plan = planWithWorkItems([
      {
        id: 'WI-1',
        // acceptance omitted intentionally
        verification: 'v',
        claims: ['src/a.ts'],
        depends_on: [],
        addresses: ['R1'],
      },
    ]);
    const handoff = minimalResolvedHandoff(['[R1] works']);
    const diagnostics = compileHandoff({ planMarkdown: plan, resolvedHandoffMarkdown: handoff });
    const missing = diagnostics.filter((d) => d.rule === 'missing_acceptance_criteria');
    expect(missing).toHaveLength(1);
    expect(missing[0].severity).toBe('error');
    expect(missing[0].work_item).toBe('WI-1');
  });

  it('rule missing_verification: work-item without a verification field is a warning', () => {
    const plan = planWithWorkItems([
      {
        id: 'WI-1',
        acceptance: 'works',
        // verification omitted
        claims: ['src/a.ts'],
        depends_on: [],
        addresses: ['R1'],
      },
    ]);
    const handoff = minimalResolvedHandoff(['[R1] works']);
    const diagnostics = compileHandoff({ planMarkdown: plan, resolvedHandoffMarkdown: handoff });
    const missing = diagnostics.filter((d) => d.rule === 'missing_verification');
    expect(missing).toHaveLength(1);
    expect(missing[0].severity).toBe('warning');
    expect(missing[0].work_item).toBe('WI-1');
  });

  it('rule empty_claims: work-item with empty claims is a warning', () => {
    const plan = planWithWorkItems([
      {
        id: 'WI-1',
        acceptance: 'works',
        verification: 'v',
        claims: [],
        depends_on: [],
        addresses: ['R1'],
      },
    ]);
    const handoff = minimalResolvedHandoff(['[R1] works']);
    const diagnostics = compileHandoff({ planMarkdown: plan, resolvedHandoffMarkdown: handoff });
    const empty = diagnostics.filter((d) => d.rule === 'empty_claims');
    expect(empty).toHaveLength(1);
    expect(empty[0].severity).toBe('warning');
    expect(empty[0].work_item).toBe('WI-1');
  });

  it('rule untraced_uat_scenario: UAT scenario traces_to unknown work-item', () => {
    const plan = planWithWorkItems([
      {
        id: 'WI-1',
        acceptance: 'works',
        verification: 'v',
        claims: ['src/x.ts'],
        depends_on: [],
        addresses: ['R1'],
      },
    ]);
    const handoff = minimalResolvedHandoff(['[R1] works']);
    const uat =
      '# UAT\n\n' +
      '## Scenario: login\n' +
      'traces_to: WI-1\n\n' +
      '## Scenario: logout\n' +
      'traces_to: WI-99\n';
    const diagnostics = compileHandoff({
      planMarkdown: plan,
      resolvedHandoffMarkdown: handoff,
      uatMarkdown: uat,
    });
    const untraced = diagnostics.filter((d) => d.rule === 'untraced_uat_scenario');
    expect(untraced).toHaveLength(1);
    expect(untraced[0].severity).toBe('warning');
    expect(untraced[0].message).toContain('WI-99');
  });

  it('produces a multi-rule diagnostic list when several issues coexist', () => {
    const plan = planWithWorkItems([
      {
        id: 'WI-1',
        // missing acceptance
        // missing verification
        claims: [],
        depends_on: ['WI-99'],
        addresses: [],
      },
    ]);
    const handoff = minimalResolvedHandoff(['[R1] something']);
    const diagnostics = compileHandoff({ planMarkdown: plan, resolvedHandoffMarkdown: handoff });
    const rules = new Set(diagnostics.map((d) => d.rule));
    expect(rules.has('unaddressed_requirement')).toBe(true);
    expect(rules.has('unknown_dependency')).toBe(true);
    expect(rules.has('missing_acceptance_criteria')).toBe(true);
    expect(rules.has('missing_verification')).toBe(true);
    expect(rules.has('empty_claims')).toBe(true);
  });

  it('handles missing Acceptance Criteria section gracefully (no crash, no false positives)', () => {
    const plan = planWithWorkItems([
      {
        id: 'WI-1',
        acceptance: 'works',
        verification: 'v',
        claims: ['src/x.ts'],
        depends_on: [],
        addresses: [],
      },
    ]);
    const handoff = '# Resolved Handoff\n\nNo criteria section here.\n';
    const diagnostics = compileHandoff({ planMarkdown: plan, resolvedHandoffMarkdown: handoff });
    // No unaddressed_requirement issued because there are no labeled criteria.
    const unaddressed = diagnostics.filter((d) => d.rule === 'unaddressed_requirement');
    expect(unaddressed).toHaveLength(0);
  });
});

/* ================================ writeDiagnosticsToPlanFrontmatter ================================ */

describe('writeDiagnosticsToPlanFrontmatter', () => {
  beforeEach(() => {
    vol.reset();
  });

  it('writes the compiler_diagnostics array to plan frontmatter, replacing previous values', () => {
    vol.fromJSON({
      '/q/IMPLEMENTATION_PLAN.md':
        '---\ncompiler_diagnostics:\n  - severity: error\n    rule: stale\n---\n\n# Plan\n',
    });
    const diagnostics: CompilerDiagnostic[] = [
      { severity: 'warning', rule: 'empty_claims', message: 'WI-1 has no claims', work_item: 'WI-1' },
    ];
    writeDiagnosticsToPlanFrontmatter('/q/IMPLEMENTATION_PLAN.md', diagnostics);
    const fm = readPlanFrontmatter('/q/IMPLEMENTATION_PLAN.md');
    expect(fm.compiler_diagnostics).toEqual([
      { severity: 'warning', rule: 'empty_claims', message: 'WI-1 has no claims', work_item: 'WI-1' },
    ]);
  });

  it('creates the plan file when missing', () => {
    writeDiagnosticsToPlanFrontmatter('/q/IMPLEMENTATION_PLAN.md', []);
    expect(fs.existsSync('/q/IMPLEMENTATION_PLAN.md')).toBe(true);
    const fm = readPlanFrontmatter('/q/IMPLEMENTATION_PLAN.md');
    expect(fm.compiler_diagnostics).toEqual([]);
  });
});

/* ================================ checkLockedOutWrites ================================ */

describe('checkLockedOutWrites', () => {
  it('emits an anomaly_detected payload (tier=log) when a touched file matches a locked_out pattern', () => {
    const anomalies = checkLockedOutWrites({
      questId: 'q1',
      runId: 'r1',
      lockedOutPatterns: ['src/protected/**'],
      touchedFiles: ['src/protected/foo.ts', 'src/safe/bar.ts'],
    });
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].event).toBe('anomaly_detected');
    expect(anomalies[0].tier).toBe('log');
    expect(anomalies[0].rule).toBe('locked_out_write');
    expect(anomalies[0].should_pause).toBe(false);
    expect(anomalies[0].details?.path).toBe('src/protected/foo.ts');
    expect(anomalies[0].details?.lockedOutPattern).toBe('src/protected/**');
    expect(anomalies[0].runId).toBe('r1');
    expect(anomalies[0].questId).toBe('q1');
  });

  it('emits no anomalies when nothing matches', () => {
    const anomalies = checkLockedOutWrites({
      questId: 'q1',
      runId: 'r1',
      lockedOutPatterns: ['src/protected/**'],
      touchedFiles: ['src/safe/bar.ts'],
    });
    expect(anomalies).toEqual([]);
  });

  it('emits no anomalies when no patterns are configured', () => {
    const anomalies = checkLockedOutWrites({
      questId: 'q1',
      runId: 'r1',
      lockedOutPatterns: [],
      touchedFiles: ['src/anything.ts'],
    });
    expect(anomalies).toEqual([]);
  });

  it('matches a single exact path pattern', () => {
    const anomalies = checkLockedOutWrites({
      questId: 'q1',
      runId: 'r1',
      lockedOutPatterns: ['src/secret.ts'],
      touchedFiles: ['src/secret.ts', 'src/other.ts'],
    });
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].details?.path).toBe('src/secret.ts');
  });

  it('emits one anomaly per (path, pattern) match', () => {
    const anomalies = checkLockedOutWrites({
      questId: 'q1',
      runId: 'r1',
      lockedOutPatterns: ['src/protected/**', 'docs/**'],
      touchedFiles: ['src/protected/a.ts', 'src/protected/b.ts', 'docs/readme.md'],
    });
    expect(anomalies).toHaveLength(3);
  });
});
