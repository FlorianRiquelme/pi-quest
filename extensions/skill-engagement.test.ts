import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fs, vol } from 'memfs';
import { engageSkillFactory } from './skill-engagement';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { default: fs, ...fs };
});

interface MockPi {
  getCommands: () => Array<{
    name: string;
    source: 'skill' | 'extension' | 'prompt';
    sourceInfo: { path: string; baseDir?: string };
  }>;
  sendUserMessage: ReturnType<typeof vi.fn>;
}

function makePi(opts: {
  skills?: Array<{ name: string; path: string; baseDir?: string }>;
  /** Match pi 0.75 (prefixed `skill:` names) or pre-0.75 (bare names). */
  nameStyle?: 'prefixed' | 'bare';
}): MockPi {
  const skills = opts.skills ?? [];
  const prefixed = opts.nameStyle !== 'bare';
  return {
    getCommands: () =>
      skills.map((s) => ({
        name: prefixed ? `skill:${s.name}` : s.name,
        source: 'skill' as const,
        // pi 0.75: sourceInfo.baseDir is the PACKAGE root, not the skill dir.
        sourceInfo: { path: s.path, baseDir: s.baseDir ?? '/proj' },
      })),
    sendUserMessage: vi.fn(),
  };
}

describe('engageSkill', () => {
  beforeEach(() => {
    vol.reset();
  });

  it('pushes a <skill> block via sendUserMessage and returns true when the skill exists', async () => {
    vol.fromJSON({
      '/proj/skills/launch-review/SKILL.md':
        '---\nname: quest-launch-review\ndescription: Trust Trinity walkthrough.\n---\n\nWelcome to Launch Review.',
    });
    const pi = makePi({
      skills: [
        { name: 'quest-launch-review', path: '/proj/skills/launch-review/SKILL.md' },
      ],
    });

    const engageSkill = engageSkillFactory(pi as any);
    const ok = await engageSkill('quest-launch-review');

    expect(ok).toBe(true);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    const payload = pi.sendUserMessage.mock.calls[0][0] as string;
    expect(payload).toContain(
      '<skill name="quest-launch-review" location="/proj/skills/launch-review/SKILL.md">',
    );
    expect(payload).toContain('</skill>');
  });

  it('strips YAML frontmatter from the SKILL.md body before wrapping', async () => {
    vol.fromJSON({
      '/proj/skills/uat/SKILL.md':
        '---\nname: quest-uat\ndescription: UAT walkthrough.\nsome-flag: true\n---\n\nUAT body content here.',
    });
    const pi = makePi({
      skills: [{ name: 'quest-uat', path: '/proj/skills/uat/SKILL.md' }],
    });

    await engageSkillFactory(pi as any)('quest-uat');

    const payload = pi.sendUserMessage.mock.calls[0][0] as string;
    expect(payload).toContain('UAT body content here.');
    expect(payload).not.toContain('name: quest-uat');
    expect(payload).not.toContain('some-flag: true');
    // The leading `---` fence must not leak in either.
    expect(payload).not.toMatch(/^<skill[^>]+>\nReferences[^\n]+\n\n---/m);
  });

  it('uses the skill directory (not the package root) for the References line', async () => {
    vol.fromJSON({
      '/proj/skills/launch-review/SKILL.md':
        '---\nname: quest-launch-review\n---\n\nBody.',
    });
    // sourceInfo.baseDir is the package root in pi 0.75 — engagement must
    // ignore it and use the SKILL.md's parent directory instead.
    const pi = makePi({
      skills: [
        { name: 'quest-launch-review', path: '/proj/skills/launch-review/SKILL.md', baseDir: '/proj' },
      ],
    });

    await engageSkillFactory(pi as any)('quest-launch-review');

    const payload = pi.sendUserMessage.mock.calls[0][0] as string;
    expect(payload).toContain('References are relative to /proj/skills/launch-review.');
    expect(payload).not.toContain('References are relative to /proj.\n');
  });

  it('matches when pi reports bare skill names (pre-0.75 compatibility)', async () => {
    vol.fromJSON({
      '/proj/skills/launch-review/SKILL.md':
        '---\nname: quest-launch-review\n---\n\nBody.',
    });
    const pi = makePi({
      skills: [{ name: 'quest-launch-review', path: '/proj/skills/launch-review/SKILL.md' }],
      nameStyle: 'bare',
    });

    const ok = await engageSkillFactory(pi as any)('quest-launch-review');
    expect(ok).toBe(true);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('returns false and does not send a message when the skill is not loaded', async () => {
    const pi = makePi({ skills: [] });

    const ok = await engageSkillFactory(pi as any)('quest-launch-review');

    expect(ok).toBe(false);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
});
