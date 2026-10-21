// JSONL 기록자와 SDK 메시지 축약 (DESIGN v2 §9.4, 리뷰 M2).
// - 줄마다 동기 append — 에피소드가 죽어도 그때까지의 줄은 남는다.
// - SDK 메시지는 **원형을 남기지 않는다**. 도구 결과는 길이·sha256·알려진 거부 문구 분류만, 도구 입력은 경로·명령·길이만.
// - 모든 줄은 쓰기 직전에 문자열 값마다 redactText 를 한 번 더 지난다 (직렬화한 줄이 아니라 값에 — redactDeep).

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { GATE_MESSAGES } from '../../../src/main/gates/decide';
import { H_REASONS } from './conditions';
import { DECLINED_MESSAGE } from './policy';
import { redactText, type RedactContext } from './redact';
import { SAFETY_MODEL_REASON } from './safety';

export interface Recorder {
  /** `t`(시작 기준 ms)를 붙여 한 줄 쓴다. 던지지 않는다. */
  write(event: Readonly<Record<string, unknown>>): void;
  readonly redact: (text: string) => string;
}

/**
 * 문자열 값마다 가린 뒤 직렬화한다. 직렬화한 줄에 가리기를 돌리면 `\\n@bot.event` 의 `n@bot.event` 를 이메일로 오인해
 * 역슬래시만 남기고 줄을 깨뜨린다 (본 실행 ksc-20261008-0657 의 4줄).
 */
const redactDeep = (value: unknown, redact: (text: string) => string): unknown => {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact));
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, redact)]));
  return value;
};

export function createJsonlRecorder(file: string, ctx: RedactContext, now: () => number, t0: number): Recorder {
  mkdirSync(path.dirname(file), { recursive: true });
  const redact = (text: string): string => redactText(text, ctx);
  return {
    redact,
    write(event) {
      try {
        appendFileSync(file, `${JSON.stringify(redactDeep({ ...event, t: now() - t0 }, redact))}\n`);
      } catch {
        // 기록 실패가 에피소드를 죽이지 않는다. 결측은 extract 가 line 수로 드러낸다.
      }
    },
  };
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** 도구 결과·거부 사유에서 알아볼 문구. 결과 원문 대신 이 분류만 남긴다. */
const KNOWN_MESSAGES: readonly (readonly [string, string])[] = [
  ['safety', SAFETY_MODEL_REASON],
  ['policy_declined', DECLINED_MESSAGE],
  ...Object.entries(GATE_MESSAGES).map(([rule, m]) => [`gate_${rule}`, m.modelReason] as const),
  // H 의 바꾼 사유도 같은 규칙 id 로 (DESIGN N11) — 빠지면 H 의 파일 거부가 거부로 집계되지 않는다
  ...Object.entries(H_REASONS).map(([rule, text]) => [`gate_${rule}`, text as string] as const),
];

export function classifyKnownMessage(text: string): string | null {
  for (const [id, message] of KNOWN_MESSAGES) if (text.includes(message)) return id;
  return null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const relativeTo = (runDir: string, cwd: string, p: string | undefined): string | undefined => {
  if (p === undefined) return undefined;
  const abs = path.resolve(cwd, p);
  const rel = path.relative(runDir, abs);
  return rel.startsWith('..') || path.isAbsolute(rel) ? '<OUTSIDE>' : rel.split(path.sep).join('/');
};

/** 도구 입력 요약. 내용은 길이·해시만. */
export function summarizeToolInput(name: string, input: unknown, runDir: string, redact: (t: string) => string): Record<string, unknown> {
  if (!isRecord(input)) return { unreadable: true };
  switch (name) {
    case 'Bash':
      return { command: redact(str(input.command) ?? ''), background: input.run_in_background === true };
    case 'Write': {
      const content = str(input.content) ?? '';
      return { path: relativeTo(runDir, runDir, str(input.file_path)), contentLen: content.length, contentSha256: sha256(content) };
    }
    case 'Edit':
    case 'MultiEdit':
      return { path: relativeTo(runDir, runDir, str(input.file_path)), newLen: (str(input.new_string) ?? '').length };
    case 'NotebookEdit':
      return { path: relativeTo(runDir, runDir, str(input.notebook_path)) };
    case 'Read':
      return { path: relativeTo(runDir, runDir, str(input.file_path)) };
    case 'Glob':
    case 'Grep':
      return { pattern: redact(str(input.pattern) ?? ''), path: relativeTo(runDir, runDir, str(input.path)) };
    case 'AskUserQuestion': {
      const qs = Array.isArray(input.questions) ? input.questions : [];
      return {
        questions: qs.filter(isRecord).map((q) => ({
          question: redact(str(q.question) ?? ''),
          options: Array.isArray(q.options) ? q.options.filter(isRecord).map((o) => redact(str(o.label) ?? '')) : [],
        })),
      };
    }
    case 'TodoWrite':
      return { count: Array.isArray(input.todos) ? input.todos.length : 0 };
    default:
      return { keys: Object.keys(input).sort() };
  }
}

const RESULT_TEXT_MAX = 4000;
/** 오류 결과 앞부분만 남기는 길이 (DESIGN N10 c-1: sandbox 오류 문구를 보려고). 가리기를 거친다 */
const ERR_HEAD_MAX = 200;

const reduceContentBlock = (block: unknown, runDir: string, redact: (t: string) => string): unknown => {
  if (!isRecord(block)) return { type: 'unknown' };
  switch (block.type) {
    case 'text':
      return { type: 'text', text: redact(str(block.text) ?? '') };
    case 'thinking':
      return { type: 'thinking', len: (str(block.thinking) ?? '').length };
    case 'tool_use': {
      const name = str(block.name) ?? '';
      return { type: 'tool_use', id: str(block.id), name, input: summarizeToolInput(name, block.input, runDir, redact) };
    }
    case 'tool_result': {
      const raw = block.content;
      const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.filter(isRecord).map((c) => str(c.text) ?? '').join('\n') : '';
      return {
        type: 'tool_result',
        tool_use_id: str(block.tool_use_id),
        is_error: block.is_error === true,
        len: text.length,
        sha256: sha256(text),
        known: classifyKnownMessage(text),
        ...(block.is_error === true ? { errHead: redact(text.slice(0, ERR_HEAD_MAX)) } : {}),
      };
    }
    default:
      return { type: str(block.type) ?? 'unknown' };
  }
};

/** SDK 메시지를 기록용으로 줄인다. 모르는 메시지는 type·subtype 만. */
export function reduceSdkMessage(message: unknown, runDir: string, redact: (t: string) => string): Record<string, unknown> {
  if (!isRecord(message)) return { type: 'unknown' };
  const type = str(message.type) ?? 'unknown';
  if (type === 'system' && message.subtype === 'init') {
    return {
      type,
      subtype: 'init',
      model: str(message.model),
      tools: Array.isArray(message.tools) ? message.tools : [],
      mcp_servers: Array.isArray(message.mcp_servers) ? message.mcp_servers.filter(isRecord).map((s) => str(s.name)) : [],
      claude_code_version: str(message.claude_code_version),
      permissionMode: str(message.permissionMode),
    };
  }
  if (type === 'assistant' || type === 'user') {
    const inner = isRecord(message.message) ? message.message : {};
    const content = inner.content;
    return {
      type,
      parent_tool_use_id: message.parent_tool_use_id ?? null,
      ...(type === 'assistant' ? { model: str(inner.model) } : {}),
      content:
        typeof content === 'string'
          ? [{ type: 'prompt', len: content.length }]
          : Array.isArray(content)
            ? content.map((b) => reduceContentBlock(b, runDir, redact))
            : [],
    };
  }
  if (type === 'result') {
    const denials = Array.isArray(message.permission_denials) ? message.permission_denials.filter(isRecord) : [];
    return {
      type,
      subtype: str(message.subtype),
      is_error: message.is_error === true,
      num_turns: message.num_turns,
      duration_ms: message.duration_ms,
      duration_api_ms: message.duration_api_ms,
      total_cost_usd: message.total_cost_usd,
      usage: message.usage,
      modelUsage: message.modelUsage,
      permission_denials: denials.map((d) => ({ tool_name: str(d.tool_name), tool_use_id: str(d.tool_use_id) })),
      api_error_status: message.api_error_status ?? null,
      errors: Array.isArray(message.errors) ? message.errors.map((e) => redact(String(e)).slice(0, 300)) : [],
      terminal_reason: message.terminal_reason ?? null,
      stop_reason: message.stop_reason ?? null,
      result: redact(str(message.result) ?? '').slice(0, RESULT_TEXT_MAX),
    };
  }
  return { type, subtype: str(message.subtype) };
}
