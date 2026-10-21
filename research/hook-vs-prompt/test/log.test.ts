import { describe, expect, it } from 'vitest';

import { GATE_MESSAGES } from '../../../src/main/gates/decide';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { H_REASONS } from '../src/conditions';
import { classifyKnownMessage, createJsonlRecorder, reduceSdkMessage } from '../src/log';
import { redactText } from '../src/redact';
import { SAFETY_MODEL_REASON } from '../src/safety';

const RUN = '/private/var/folders/x/T/hvp-run-1';
const ctx = { runDir: RUN, home: '/Users/tester', user: 'tester' };
const redact = (t: string): string => redactText(t, ctx);

describe('가리기 (리뷰 M2)', () => {
  it('실행 폴더(별칭 포함)·홈·사용자 이름·이메일·키 형태를 자리표시자로', () => {
    const text = `cd /var/folders/x/T/hvp-run-1 && cat /Users/tester/.zshrc # a.b@example.com sk-ant-api03-abcdefghijklmnop tester`;
    const out = redact(text);
    expect(out).toBe('cd <RUN_DIR> && cat <HOME>/.zshrc # <EMAIL> <SECRET> <USER>');
  });

  it('다른 사용자의 /Users 경로도 가린다', () => {
    expect(redact('ls /Users/someoneelse/Desktop')).toBe('ls /Users/<USER>/Desktop');
  });
});

describe('SDK 메시지 축약 — 도구 결과 원문을 남기지 않는다 (M2)', () => {
  it('tool_result 는 길이·sha256·알려진 거부 분류만', () => {
    const reduced = reduceSdkMessage(
      {
        type: 'user',
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'PATH=/x SECRET=hunter2' }] },
      },
      RUN,
      redact,
    );
    expect(JSON.stringify(reduced)).not.toContain('hunter2');
    expect(reduced).toMatchObject({ content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, len: 22, known: null }] });
  });

  it('오류 결과만 앞 200자를 가려서 errHead 로 남긴다 (DESIGN N10 c-1: sandbox 오류 문구) — 성공 결과에는 없다', () => {
    const err = `mkdir: ${RUN}/app: Operation not permitted sk-ant-api03-ABCDEFGHIJKLMNOP ` + 'x'.repeat(400);
    const reduced = reduceSdkMessage({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: err }] } }, RUN, redact) as { content: { errHead?: string }[] };
    const head = reduced.content[0]?.errHead ?? '';
    expect(head).toContain('Operation not permitted');
    expect(head).not.toContain(RUN);
    expect(head).not.toContain('sk-ant-api03-ABCDEFGHIJKLMNOP');
    expect(head.length).toBeLessThanOrEqual(220);
    const ok = reduceSdkMessage({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', is_error: false, content: 'fine' }] } }, RUN, redact) as { content: Record<string, unknown>[] };
    expect(ok.content[0]).not.toHaveProperty('errHead');
  });

  it('거부 문구를 알아본다: 관문·safety·정책', () => {
    expect(classifyKnownMessage(`Error: ${GATE_MESSAGES.plan_missing.modelReason}`)).toBe('gate_plan_missing');
    expect(classifyKnownMessage(SAFETY_MODEL_REASON)).toBe('safety');
    expect(classifyKnownMessage('The user declined this tool call. Ask the user how to proceed instead of retrying it.')).toBe(
      'policy_declined',
    );
  });

  it('Write 입력은 경로·길이·해시만 — 내용이 없다', () => {
    const reduced = reduceSdkMessage(
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { model: 'm', content: [{ type: 'tool_use', id: 'x', name: 'Write', input: { file_path: `${RUN}/a.js`, content: 'const k = 1;' } }] },
      },
      RUN,
      redact,
    );
    expect(reduced).toMatchObject({ content: [{ type: 'tool_use', name: 'Write', input: { path: 'a.js', contentLen: 12 } }] });
    expect(JSON.stringify(reduced)).not.toContain('const k');
  });

  it('system/init 은 필요한 필드만 — cwd·계정류 없음', () => {
    const reduced = reduceSdkMessage(
      { type: 'system', subtype: 'init', cwd: RUN, model: 'm', tools: ['Read'], apiKeySource: 'x', claude_code_version: '2.1.269', mcp_servers: [] },
      RUN,
      redact,
    );
    expect(Object.keys(reduced).sort()).toEqual(['claude_code_version', 'mcp_servers', 'model', 'permissionMode', 'subtype', 'tools', 'type']);
  });
});

describe('기록기 — 가리기가 JSON 이스케이프를 깨지 않는다 (본 실행 ksc-20261008-0657 사고)', () => {
  it('문자열 안 \\n 뒤의 @x.yy 를 이메일로 오인해 줄을 깨뜨리지 않고, 진짜 이메일은 가린다', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'hvp-logtest-')), 'a.jsonl');
    const rec = createJsonlRecorder(file, ctx, () => 5, 0);
    rec.write({ type: 'x', command: "TOKEN = os.getenv('T')\n\n@bot.event\nasync def f(): pass", mail: 'mail me: a.b@example.com', nested: [{ p: '/Users/tester/x' }] });
    const line = readFileSync(file, 'utf8').trim();
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.command).toBe("TOKEN = os.getenv('T')\n\n@bot.event\nasync def f(): pass");
    expect(parsed.mail).toBe('mail me: <EMAIL>');
    expect(parsed.nested).toEqual([{ p: '<HOME>/x' }]);
    expect(parsed.t).toBe(5);
  });
});

describe('H 의 바꾼 거부 사유도 같은 규칙으로 분류한다 (DESIGN N11)', () => {
  it('plan_missing·bash_write_without_plan', () => {
    expect(classifyKnownMessage(H_REASONS.plan_missing as string)).toBe('gate_plan_missing');
    expect(classifyKnownMessage(H_REASONS.bash_write_without_plan as string)).toBe('gate_bash_write_without_plan');
  });
});
