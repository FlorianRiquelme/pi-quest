import { describe, it, expect } from 'vitest';
import {
  isValidTransition,
  deriveQuestId,
  generateTimestampId,
  collisionSuffixed,
  VALID_STATUS_TRANSITIONS,
  type QuestStatus,
} from './lib';

describe('isValidTransition', () => {
  it('allows valid forward transitions', () => {
    expect(isValidTransition('intake', 'recon-ready')).toBe(true);
    expect(isValidTransition('intake', 'reviewing')).toBe(true);
    expect(isValidTransition('recon-ready', 'reviewing')).toBe(true);
    expect(isValidTransition('reviewing', 'needs-resolution')).toBe(true);
    expect(isValidTransition('reviewing', 'resolved')).toBe(true);
    expect(isValidTransition('needs-resolution', 'reviewing')).toBe(true);
    expect(isValidTransition('needs-resolution', 'resolved')).toBe(true);
    expect(isValidTransition('resolved', 'planned')).toBe(true);
    expect(isValidTransition('planned', 'launch-review')).toBe(true);
    expect(isValidTransition('launch-review', 'executing')).toBe(true);
    expect(isValidTransition('executing', 'blocked')).toBe(true);
    expect(isValidTransition('executing', 'verification')).toBe(true);
    expect(isValidTransition('blocked', 'executing')).toBe(true);
    expect(isValidTransition('verification', 'verification-ready')).toBe(true);
    expect(isValidTransition('verification', 'blocked')).toBe(true);
    expect(isValidTransition('verification-ready', 'uat-ready')).toBe(true);
    expect(isValidTransition('uat-ready', 'completed')).toBe(true);
    expect(isValidTransition('uat-ready', 'uat-failed')).toBe(true);
    expect(isValidTransition('completed', 'archived')).toBe(true);
  });

  it('blocks invalid transitions', () => {
    expect(isValidTransition('intake', 'completed')).toBe(false);
    expect(isValidTransition('archived', 'intake')).toBe(false);
    expect(isValidTransition('executing', 'intake')).toBe(false);
    expect(isValidTransition('resolved', 'intake')).toBe(false);
  });

  describe('launch-review (M2-1)', () => {
    it('is registered in the transition whitelist', () => {
      expect(VALID_STATUS_TRANSITIONS['launch-review' as QuestStatus]).toBeDefined();
    });

    it('allows planned → launch-review', () => {
      expect(isValidTransition('planned', 'launch-review')).toBe(true);
    });

    it('allows launch-review → executing', () => {
      expect(isValidTransition('launch-review', 'executing')).toBe(true);
    });

    it('allows launch-review → blocked (cancel path)', () => {
      expect(isValidTransition('launch-review', 'blocked')).toBe(true);
    });

    it('disallows planned → executing (must go through launch-review)', () => {
      expect(isValidTransition('planned', 'executing')).toBe(false);
    });

    it('disallows launch-review → unrelated stages', () => {
      expect(isValidTransition('launch-review', 'intake')).toBe(false);
      expect(isValidTransition('launch-review', 'verification')).toBe(false);
      expect(isValidTransition('launch-review', 'completed')).toBe(false);
    });
  });

  it('returns false for unknown from-status', () => {
    expect(isValidTransition('unknown' as any, 'intake')).toBe(false);
  });

  it('respects blocked as a flexible recovery state', () => {
    expect(isValidTransition('blocked', 'needs-resolution')).toBe(true);
    expect(isValidTransition('blocked', 'reviewing')).toBe(true);
    expect(isValidTransition('blocked', 'resolved')).toBe(true);
    expect(isValidTransition('blocked', 'planned')).toBe(true);
    expect(isValidTransition('blocked', 'verification')).toBe(true);
  });
});

describe('deriveQuestId', () => {
  it('uses explicitId first', () => {
    expect(deriveQuestId({ explicitId: 'My Quest' })).toBe('my-quest');
  });

  it('derives from branch with feature/fix/bug prefix', () => {
    expect(deriveQuestId({ branch: 'feature/PROJ-123' })).toBe('proj-123');
    expect(deriveQuestId({ branch: 'fix/bug-456' })).toBe('bug-456');
    expect(deriveQuestId({ branch: 'bug/ABC-789' })).toBe('abc-789');
  });

  it('derives from handoffPath with ticket pattern', () => {
    expect(deriveQuestId({ handoffPath: 'docs/handoff/FOO-789.md' })).toBe('foo-789');
  });

  it('falls back to filename from handoffPath', () => {
    expect(deriveQuestId({ handoffPath: 'some/nested/thing.md' })).toBe('thing');
  });

  it('derives from handoffTitle with ticket pattern', () => {
    expect(deriveQuestId({ handoffTitle: 'Ticket ABC-001: Fix bug' })).toBe('abc-001');
  });

  it('falls back to slugified handoffTitle', () => {
    expect(deriveQuestId({ handoffTitle: 'Just a title' })).toBe('just-a-title');
  });

  it('returns undefined when no inputs given', () => {
    expect(deriveQuestId({})).toBeUndefined();
  });

  it('ignores branch when explicitId is present', () => {
    expect(deriveQuestId({ explicitId: 'override', branch: 'feature/PROJ-123' })).toBe('override');
  });
});

describe('generateTimestampId', () => {
  it('produces a quest-prefixed 14-digit timestamp', () => {
    const id = generateTimestampId();
    expect(id).toMatch(/^quest-\d{14}$/);
  });
});

describe('collisionSuffixed', () => {
  it('returns base when no collision', () => {
    expect(collisionSuffixed('abc', new Set(['def', 'ghi']))).toBe('abc');
  });

  it('appends -2 on first collision', () => {
    expect(collisionSuffixed('abc', new Set(['abc']))).toBe('abc-2');
  });

  it('increments suffix until free', () => {
    expect(collisionSuffixed('abc', new Set(['abc', 'abc-2', 'abc-3']))).toBe('abc-4');
  });
});
