import { describe, expect, it } from 'vitest';

import { CONDITION_IDS, CONDITIONS, type ConditionId } from '../src/conditions';
import { scrubEnv } from '../src/env';
import { assembleOptions } from '../src/assemble';
import { checkConditionDiff, describeOptions, diffKeys, hashOptions } from '../src/optionsHash';
import { MODELS } from '../src/options';
import { memoryRecorder } from './helpers';

const FAKE_ENV = { PATH: '/usr/bin:/bin', HOME: '/Users/someone', SECRET_TOKEN: 'zzz-not-real', ANTHROPIC_API_KEY: 'placeholder' };

const assemble = (cond: ConditionId, runDir: string) => {
  const { env, authKeys } = scrubEnv(FAKE_ENV, { npm_config_cache: `${runDir}/.npm-cache` });
  return assembleOptions({
    condition: CONDITIONS[cond],
    runDir,
    recorder: memoryRecorder(),
    turn: () => 1,
    readFileText: () => undefined,
    model: MODELS.haiku,
    maxBudgetUsd: 1.5,
    env,
    authKeys,
    abortController: new AbortController(),
  });
};

// 실행마다 runDir 이 다르다 — 조건마다 다른 폴더로 만들어도 해시 비교가 되어야 한다.
const dirOf = (cond: string): string => `/private/var/folders/x/T/hvp-${cond}-${Math.random().toString(36).slice(2, 8)}`;

describe('optionsHash (리뷰 M6)', () => {
  it('같은 조건, 다른 runDir → 같은 해시 (runDir 을 <RUN_DIR> 로 정규화)', () => {
    expect(assemble('C', dirOf('a')).optionsHash).toBe(assemble('C', dirOf('b')).optionsHash);
  });

  it('조건 쌍의 차이 키가 허용된 집합과 정확히 같다', () => {
    for (const x of CONDITION_IDS) {
      for (const y of CONDITION_IDS) {
        const check = checkConditionDiff(x, y, assemble(x, dirOf(x)).description, assemble(y, dirOf(y)).description);
        expect({ pair: `${x}|${y}`, ...check }).toMatchObject({ pair: `${x}|${y}`, ok: true });
      }
    }
  });

  it('A 대 B 는 append 만, A 대 C 는 PreToolUse hook 만 다르다 (사람이 읽는 형태로 한 번 더)', () => {
    expect(diffKeys(assemble('A', dirOf('a')).description, assemble('B', dirOf('b')).description)).toEqual(['systemPrompt.append']);
    expect(diffKeys(assemble('A', dirOf('a')).description, assemble('C', dirOf('c')).description)).toEqual(['hooks.PreToolUse']);
  });

  it('숨은 차이는 잡힌다 — 모델을 바꾸면 허용 집합을 벗어난다', () => {
    const a = assemble('A', dirOf('a')).description;
    const b = describeOptions({ ...assemble('B', dirOf('b')).options, model: MODELS.sonnet }, '/nowhere');
    expect(diffKeys(a, b)).toContain('model');
  });

  it('설명에는 env 값·runDir·이름 없는 함수가 없다 (M2)', () => {
    const runDir = dirOf('c');
    const { description } = assemble('C', runDir);
    const text = JSON.stringify(description);
    expect(text).not.toContain('placeholder');
    expect(text).not.toContain('zzz-not-real');
    expect(text).not.toContain('/Users/someone');
    expect(text).not.toContain(runDir);
    expect(text).not.toContain('fn:unlabeled');
    expect(hashOptions(description)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('공통 옵션 (DESIGN v2 §2.1)', () => {
  it('SDK CRITICAL 규칙과 sandbox 필수 값', () => {
    const runDir = dirOf('a');
    const { options } = assemble('A', runDir);
    expect(options).toMatchObject({
      cwd: runDir,
      permissionMode: 'default',
      settingSources: [],
      strictMcpConfig: true,
      allowedTools: ['Read', 'Glob', 'Grep'],
      persistSession: false,
      enableFileCheckpointing: false,
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: false,
        allowUnsandboxedCommands: false,
        credentials: { envVars: [{ name: 'ANTHROPIC_API_KEY', mode: 'deny' }] },
      },
    });
    expect(options.disallowedTools).toEqual([`Edit(/${runDir}/.harness/**)`, 'Skill', 'Agent', 'Task', 'WebFetch', 'WebSearch']);
    expect(options.tools).toEqual(['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep', 'Bash', 'AskUserQuestion', 'TaskOutput', 'TaskStop']);
    expect(options).not.toHaveProperty('mcpServers');
    expect(options).not.toHaveProperty('outputFormat');
  });

  it('E 만 sandbox 가 실행 폴더 쓰기를 거부한다 (denyWrite) — 나머지 조건은 실행 폴더 쓰기 허용 그대로 (N9)', () => {
    const runDir = dirOf('e');
    expect(assemble('E', runDir).options.sandbox?.filesystem).toEqual({ allowWrite: [runDir], denyWrite: [runDir], denyRead: ['~'] });
    expect(assemble('Cp', runDir).options.sandbox?.filesystem).toEqual({ allowWrite: [runDir], denyRead: ['~'] });
  });

  it('env 는 허용 목록만 펼쳐서 넘긴다 — 모르는 변수는 빠진다', () => {
    const { options } = assemble('A', dirOf('a'));
    expect(Object.keys(options.env ?? {}).sort()).toEqual(['ANTHROPIC_API_KEY', 'HOME', 'PATH', 'npm_config_cache']);
  });

  it('PreToolUse 순서: safety → 관찰 → 관문(C 만)', () => {
    const pre = assemble('C', dirOf('c')).description as { hooks: { PreToolUse: { hooks: string[]; matcher?: string }[] } };
    expect(pre.hooks.PreToolUse.map((m) => [m.matcher ?? null, m.hooks])).toEqual([
      [null, ['fn:safety']],
      [null, ['fn:observe.pre']],
      ['Write|Edit|NotebookEdit', ['fn:gate.Write|Edit|NotebookEdit']],
      ['Bash', ['fn:gate.Bash']],
    ]);
  });
});
