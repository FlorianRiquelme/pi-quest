import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fs, vol } from 'memfs';
import { ensureDir, readJsonIfExists, writeJson, appendCappedTail, getPiInvocation } from './fs-utils';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { default: fs, ...fs };
});

describe('fs-utils', () => {
  beforeEach(() => {
    vol.reset();
  });

  describe('ensureDir', () => {
    it('creates missing directories recursively', () => {
      ensureDir('/a/b/c');
      expect(vol.existsSync('/a/b/c')).toBe(true);
    });

    it('is a no-op when directory already exists', () => {
      vol.mkdirSync('/existing', { recursive: true });
      ensureDir('/existing');
      expect(vol.existsSync('/existing')).toBe(true);
    });
  });

  describe('readJsonIfExists', () => {
    it('returns parsed JSON when file exists', () => {
      vol.writeFileSync('/data.json', '{"hello":"world"}');
      expect(readJsonIfExists('/data.json')).toEqual({ hello: 'world' });
    });

    it('returns undefined when file is missing', () => {
      expect(readJsonIfExists('/missing.json')).toBeUndefined();
    });

    it('returns undefined for malformed JSON', () => {
      vol.writeFileSync('/bad.json', 'not json');
      expect(readJsonIfExists('/bad.json')).toBeUndefined();
    });
  });

  describe('writeJson', () => {
    it('writes pretty-printed JSON with trailing newline', () => {
      writeJson('/out/data.json', { foo: 1 });
      const content = vol.readFileSync('/out/data.json', 'utf-8') as string;
      expect(content).toBe('{\n  "foo": 1\n}\n');
    });

    it('creates parent directories automatically', () => {
      writeJson('/deep/nested/file.json', { a: 1 });
      expect(vol.existsSync('/deep/nested')).toBe(true);
    });
  });

  describe('appendCappedTail', () => {
    it('appends text when under maxChars', () => {
      const result = appendCappedTail('hello', ' world', 100);
      expect(result.value).toBe('hello world');
      expect(result.truncated).toBe(false);
    });

    it('truncates from the front when combined exceeds maxChars', () => {
      const result = appendCappedTail('abcdef', 'ghij', 8);
      expect(result.value).toBe('cdefghij');
      expect(result.truncated).toBe(true);
    });

    it('truncates a single huge chunk to its tail', () => {
      const big = 'x'.repeat(20);
      const result = appendCappedTail('', big, 10);
      expect(result.value).toBe('x'.repeat(10));
      expect(result.truncated).toBe(true);
    });
  });

  describe('getPiInvocation', () => {
    const originalArgv1 = process.argv[1];
    const originalExecPath = process.execPath;

    afterEach(() => {
      process.argv[1] = originalArgv1;
      Object.defineProperty(process, 'execPath', { value: originalExecPath });
    });

    it('uses current script when available and real', () => {
      vol.mkdirSync('/app', { recursive: true });
      vol.writeFileSync('/app/cli.ts', '');
      process.argv[1] = '/app/cli.ts';
      Object.defineProperty(process, 'execPath', { value: '/usr/bin/bun' });
      expect(getPiInvocation(['--help'])).toEqual({
        command: '/usr/bin/bun',
        args: ['/app/cli.ts', '--help'],
      });
    });

    it('falls back to "pi" for generic runtimes without script', () => {
      process.argv[1] = undefined as any;
      Object.defineProperty(process, 'execPath', { value: '/usr/bin/node' });
      expect(getPiInvocation(['--help'])).toEqual({
        command: 'pi',
        args: ['--help'],
      });
    });

    it('uses execPath for non-generic runtime', () => {
      process.argv[1] = undefined as any;
      Object.defineProperty(process, 'execPath', { value: '/usr/bin/pi' });
      expect(getPiInvocation(['--help'])).toEqual({
        command: '/usr/bin/pi',
        args: ['--help'],
      });
    });
  });
});
