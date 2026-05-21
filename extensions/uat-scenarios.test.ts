import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fs, vol } from 'memfs';
import * as path from 'node:path';
import {
  parseUatScenarios,
  updateScenarioVerdict,
  type UatScenario,
} from './uat-scenarios';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { default: fs, ...fs };
});

describe('parseUatScenarios', () => {
  it('parses scenarios from YAML frontmatter', () => {
    const uat = [
      '---',
      'uat_scenarios:',
      '  - id: S1',
      '    name: "User can log in with OAuth"',
      '    setup:',
      '      - "Run: docker compose up -d"',
      '      - "Wait for: localhost:3000 to respond"',
      '    actions:',
      '      - "Open: http://localhost:3000/login"',
      '      - "Click: Sign in with Google"',
      '    verify:',
      '      - "Redirected back to dashboard with their email shown"',
      '    verdict: pending',
      '    notes: ""',
      '---',
      '',
      '# UAT plan',
      '',
      'freeform markdown',
    ].join('\n');

    const scenarios = parseUatScenarios(uat);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].id).toBe('S1');
    expect(scenarios[0].name).toBe('User can log in with OAuth');
    expect(scenarios[0].setup).toEqual([
      'Run: docker compose up -d',
      'Wait for: localhost:3000 to respond',
    ]);
    expect(scenarios[0].actions).toEqual([
      'Open: http://localhost:3000/login',
      'Click: Sign in with Google',
    ]);
    expect(scenarios[0].verify).toEqual([
      'Redirected back to dashboard with their email shown',
    ]);
    expect(scenarios[0].verdict).toBe('pending');
    expect(scenarios[0].notes).toBe('');
  });

  it('parses multiple scenarios in order', () => {
    const uat = [
      '---',
      'uat_scenarios:',
      '  - id: S1',
      '    name: "first"',
      '    setup: []',
      '    actions: []',
      '    verify:',
      '      - "ok"',
      '    verdict: pass',
      '    notes: ""',
      '  - id: S2',
      '    name: "second"',
      '    setup: []',
      '    actions: []',
      '    verify:',
      '      - "ok"',
      '    verdict: fail',
      '    notes: "broken"',
      '---',
      '',
      '# UAT',
    ].join('\n');

    const scenarios = parseUatScenarios(uat);
    expect(scenarios).toHaveLength(2);
    expect(scenarios[0].id).toBe('S1');
    expect(scenarios[0].verdict).toBe('pass');
    expect(scenarios[1].id).toBe('S2');
    expect(scenarios[1].verdict).toBe('fail');
    expect(scenarios[1].notes).toBe('broken');
  });

  it('returns empty array when no frontmatter is present', () => {
    expect(parseUatScenarios('# Just a heading\n\nNo frontmatter here.')).toEqual([]);
  });

  it('returns empty array when frontmatter has no uat_scenarios key', () => {
    const uat = '---\nother_field: value\n---\n\n# UAT\n';
    expect(parseUatScenarios(uat)).toEqual([]);
  });

  it('returns empty array when uat_scenarios is empty list', () => {
    const uat = '---\nuat_scenarios: []\n---\n\n# UAT\n';
    expect(parseUatScenarios(uat)).toEqual([]);
  });

  it('defaults missing fields to safe values', () => {
    const uat = [
      '---',
      'uat_scenarios:',
      '  - id: S1',
      '    name: "minimal"',
      '---',
    ].join('\n');

    const scenarios = parseUatScenarios(uat);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].id).toBe('S1');
    expect(scenarios[0].name).toBe('minimal');
    expect(scenarios[0].setup).toEqual([]);
    expect(scenarios[0].actions).toEqual([]);
    expect(scenarios[0].verify).toEqual([]);
    expect(scenarios[0].verdict).toBe('pending');
    expect(scenarios[0].notes).toBe('');
  });

  it('skips malformed entries (no id)', () => {
    const uat = [
      '---',
      'uat_scenarios:',
      '  - name: "no id here"',
      '    verdict: pending',
      '  - id: S2',
      '    name: "valid"',
      '---',
    ].join('\n');

    const scenarios = parseUatScenarios(uat);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].id).toBe('S2');
  });

  it('treats unknown verdict values as pending', () => {
    const uat = [
      '---',
      'uat_scenarios:',
      '  - id: S1',
      '    name: "x"',
      '    verdict: bogus',
      '---',
    ].join('\n');

    const scenarios = parseUatScenarios(uat);
    expect(scenarios[0].verdict).toBe('pending');
  });
});

describe('updateScenarioVerdict', () => {
  beforeEach(() => {
    vol.reset();
  });

  const seedUat = (): string => {
    const path = '/q/UAT.md';
    const uat = [
      '---',
      'uat_scenarios:',
      '  - id: S1',
      '    name: "first"',
      '    setup: []',
      '    actions: []',
      '    verify:',
      '      - "ok"',
      '    verdict: pending',
      '    notes: ""',
      '  - id: S2',
      '    name: "second"',
      '    setup: []',
      '    actions: []',
      '    verify:',
      '      - "ok"',
      '    verdict: pending',
      '    notes: ""',
      '---',
      '',
      '# UAT plan',
      '',
      'preserved body',
    ].join('\n');
    vol.fromJSON({ [path]: uat });
    return path;
  };

  it('updates one scenario by id, preserves others', () => {
    const path = seedUat();
    updateScenarioVerdict(path, 'S1', 'pass');
    const scenarios = parseUatScenarios(fs.readFileSync(path, 'utf-8') as string);
    expect(scenarios[0].verdict).toBe('pass');
    expect(scenarios[1].verdict).toBe('pending');
  });

  it('records notes when provided', () => {
    const path = seedUat();
    updateScenarioVerdict(path, 'S2', 'fail', 'login button missing');
    const scenarios = parseUatScenarios(fs.readFileSync(path, 'utf-8') as string);
    expect(scenarios[1].verdict).toBe('fail');
    expect(scenarios[1].notes).toBe('login button missing');
  });

  it('preserves the markdown body below frontmatter', () => {
    const path = seedUat();
    updateScenarioVerdict(path, 'S1', 'pass');
    const text = fs.readFileSync(path, 'utf-8') as string;
    expect(text).toContain('# UAT plan');
    expect(text).toContain('preserved body');
  });

  it('is a no-op when the scenario id is not present', () => {
    const path = seedUat();
    const before = fs.readFileSync(path, 'utf-8') as string;
    updateScenarioVerdict(path, 'SXX', 'pass');
    const after = fs.readFileSync(path, 'utf-8') as string;
    const scenarios = parseUatScenarios(after);
    expect(scenarios[0].verdict).toBe('pending');
    expect(scenarios[1].verdict).toBe('pending');
    // Body unchanged.
    expect(after).toContain('preserved body');
    // Specifically: no scenario was added.
    expect(scenarios).toHaveLength(2);
  });

  it('clears notes when notes argument is omitted', () => {
    const path = seedUat();
    updateScenarioVerdict(path, 'S1', 'fail', 'first try');
    updateScenarioVerdict(path, 'S1', 'pass'); // re-pass after iteration
    const scenarios = parseUatScenarios(fs.readFileSync(path, 'utf-8') as string);
    expect(scenarios[0].verdict).toBe('pass');
    expect(scenarios[0].notes).toBe('');
  });
});

/* ================================ Skill markdown ================================ */

describe('uat SKILL.md (M4-3)', () => {
  const readSkill = async (): Promise<string> => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const skillPath = path.resolve(__dirname, '..', 'skills', 'uat', 'SKILL.md');
    expect(realFs.existsSync(skillPath)).toBe(true);
    return realFs.readFileSync(skillPath, 'utf-8');
  };

  it('declares the quest-uat name', async () => {
    const content = await readSkill();
    expect(content).toMatch(/name:\s*quest-uat/);
  });

  it('walks scenarios one at a time, not as a wall', async () => {
    const content = await readSkill();
    expect(content.toLowerCase()).toContain('one scenario at a time');
  });

  it('offers the four-way verdict prompt with p/f/n/s shortcuts', async () => {
    const content = await readSkill();
    expect(content).toContain('[p]ass');
    expect(content).toContain('[f]ail');
    expect(content).toContain('[n]/a');
    expect(content).toContain('[s]kip');
  });

  it('displays setup as copy-pasteable, not auto-executed', async () => {
    const content = await readSkill();
    expect(content.toLowerCase()).toContain('copy-pasteable');
    // No affirmative auto-execute language for setup commands.
    expect(content).not.toMatch(/\bauto[- ]?execute\s+(the\s+)?setup/i);
    expect(content).not.toMatch(/run\s+the\s+setup\s+commands\s+for\s+the\s+user/i);
    expect(content).not.toMatch(/automatically\s+(run|execute)\s+setup/i);
    // And the skill must explicitly say setup is NOT auto-executed somewhere.
    expect(content).toMatch(/not\s+auto[- ]?executed/i);
  });

  it('explains the Iterate vs Accept failure loop', async () => {
    const content = await readSkill();
    expect(content).toMatch(/Iterate/);
    expect(content).toMatch(/Accept/);
    expect(content.toLowerCase()).toContain('uat-failed');
  });

  it('mentions the helper modules the skill calls', async () => {
    const content = await readSkill();
    expect(content).toMatch(/parseUatScenarios|updateScenarioVerdict/);
    expect(content).toMatch(/iterateOnFailures/);
  });

  it('points at the Reverse Prompting principle (ADR 016)', async () => {
    const content = await readSkill();
    expect(content).toMatch(/Reverse Prompting|ADR\s*016/i);
  });

  it('resume hint for skipped scenarios points at the real /skill:quest-uat invocation (issue #5)', async () => {
    const content = await readSkill();
    // No reference to the non-existent /quest uat subcommand.
    expect(content).not.toMatch(/\/quest\s+uat\b/);
    // The skipped-scenarios resolution row must tell the user how to come back.
    // Match the table cell that handles the "only skips remain" tally.
    const row = content
      .split('\n')
      .find((line) => line.includes('only skips'));
    expect(row, 'expected a tally row mentioning "only skips"').toBeTruthy();
    expect(row!).toMatch(/\/skill:quest-uat/);
  });
});
