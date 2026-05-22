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
}): MockPi {
  const skills = opts.skills ?? [];
  return {
    getCommands: () =>
      skills.map((s) => ({
        name: s.name,
        source: 'skill' as const,
        sourceInfo: { path: s.path, baseDir: s.baseDir ?? s.path.replace(/\/SKILL\.md$/, '') },
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

  it('returns false and does not send a message when the skill is not loaded', async () => {
    const pi = makePi({ skills: [] });

    const ok = await engageSkillFactory(pi as any)('quest-launch-review');

    expect(ok).toBe(false);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
});
