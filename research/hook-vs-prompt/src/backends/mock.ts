// mock SDK 백엔드 — **실제 모델을 부르지 않는다.** dry-run 과 테스트용.
//
// dry-run 이 의미가 있으려면 실제 hook·정책 경로를 지나야 한다. 그래서 이 mock 은 CLI 의 권한 흐름을 흉내 낸다:
//   1) PreToolUse hook 중 matcher 가 맞는 것을 **전부** 부른다 (실제 safety·관찰·앱 관문 코드).
//   2) deny 가 하나라도 있으면 거부, ask 면 canUseTool(decisionReason = hook 사유) — 정책 G 줄.
//   3) 그 밖에는 allowedTools(Read/Glob/Grep)와 읽기 전용 Bash(`ls`·`cat`·`pwd`) 를 스스로 허용하고, 나머지는 canUseTool.
//   4) 허용되면 실행 폴더에서 실제로 실행한다 (Write/Edit 는 파일을 쓰고, Bash 는 아래 몇 형태만 해석 — 셸을 띄우지 않는다).
//   5) PostToolUse / PostToolUseFailure 를 부른다.
// 메시지 모양은 SDK 타입의 필요한 필드만 갖춘다: system/init, assistant(tool_use·text), user(tool_result), 턴마다 result
// (total_cost_usd·modelUsage 는 **누적**, usage 는 턴별 — 리뷰 M3 을 시험하기 위해 실제와 같게).
//
// "모델 행동" 은 시드 고정 난수로 정한 가상 행동이다. 수치는 아무 의미가 없다 — 파이프라인이 끝까지 도는지만 본다.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { HookCallbackMatcher, HookJSONOutput, Options, PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { Backend, QueryHandle } from './backend';

export interface MockBehavior {
  /** 이 턴에서 (반응까지 포함해) 할 일. api 로 도구를 부르고 말한다. */
  (api: MockAgentApi, ctx: MockTurnContext): Promise<void>;
}

export interface MockTurnContext {
  readonly turn: number;
  readonly prompt: string;
  /** systemPrompt.append 가 있는가 (B·D) */
  readonly hasRule: boolean;
  readonly rng: () => number;
}

export interface ToolOutcome {
  readonly ok: boolean;
  /** 거부·실패 사유 (모델이 받는 글) */
  readonly text: string;
  /** 누가 막았나: hook_deny | policy_deny | error | null */
  readonly blockedBy: 'hook_deny' | 'policy_deny' | 'error' | null;
}

export interface MockAgentApi {
  tool(name: string, input: Record<string, unknown>): Promise<ToolOutcome>;
  say(text: string): void;
}

export interface MockOptions {
  readonly behavior: MockBehavior;
  readonly seed: number;
  /** 이 턴에서 결과 없이 멈춘다 — 시한 초과 경로 시험용 */
  readonly hangOnTurn?: number;
  /** 멈추기 전에 부를 것 (예: 실행 폴더를 argv 에 가진 자식 프로세스 띄우기) */
  readonly onHang?: (cwd: string) => void;
  /** 이 턴의 result 를 인프라 오류로 만든다 */
  readonly infraOnTurn?: number;
}

const CLI_VERSION = 'mock-0.0.0';
const MOCK_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit', 'Bash', 'AskUserQuestion', 'TodoWrite'];
const AUTO_READONLY_BASH = /^\s*(?:ls|cat|pwd|echo\s+[^>|]*$)(?:\s|$)/;

/** mulberry32 */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const matcherMatches = (m: HookCallbackMatcher, toolName: string): boolean =>
  m.matcher === undefined || new RegExp(`^(?:${m.matcher})$`).test(toolName);

type HookDecision = { kind: 'allow' | 'ask' | 'deny'; reason: string };

const readHookDecision = (out: HookJSONOutput): HookDecision | null => {
  const specific = 'hookSpecificOutput' in out ? out.hookSpecificOutput : undefined;
  if (specific?.hookEventName !== 'PreToolUse' || specific.permissionDecision === undefined) return null;
  const kind = specific.permissionDecision === 'deny' ? 'deny' : specific.permissionDecision === 'ask' ? 'ask' : 'allow';
  return { kind, reason: specific.permissionDecisionReason ?? '' };
};

/** 실행 폴더 안 경로만 쓴다. 밖이면 실패 — safety hook 이 이미 막았어야 한다. */
const insidePath = (cwd: string, p: string): string | null => {
  const abs = path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : abs;
};

const writeInside = (cwd: string, p: string, content: string): boolean => {
  const abs = insidePath(cwd, p);
  if (abs === null) return false;
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return true;
};

/** 셸을 띄우지 않고 몇 형태만 해석한다. 모르는 명령은 아무것도 하지 않고 성공. */
const runMockBash = (cwd: string, command: string): { ok: boolean; text: string } => {
  const heredoc = command.match(/^cat\s+>\s*(\S+)\s+<<'?(\w+)'?\n([\s\S]*?)\n\2\s*$/);
  if (heredoc !== null) return { ok: writeInside(cwd, heredoc[1] ?? '', `${heredoc[3] ?? ''}\n`), text: '' };
  const nodeWrite = command.match(/writeFileSync\(\s*'([^']+)'\s*,\s*'([^']*)'\s*\)/);
  if (nodeWrite !== null) return { ok: writeInside(cwd, nodeWrite[1] ?? '', nodeWrite[2] ?? ''), text: '' };
  if (/^npx\s+create-next-app/.test(command)) {
    writeInside(cwd, 'package.json', JSON.stringify({ name: 'blog', private: true, dependencies: { next: '15.0.0', react: '19.0.0' } }, null, 2));
    writeInside(cwd, 'app/page.tsx', 'export default function Home() { return <h1>Blog</h1>; }\n');
    writeInside(cwd, 'package-lock.json', '{}\n');
    return { ok: true, text: 'Success! Created blog' };
  }
  const mkdir = command.match(/^mkdir\s+-p\s+(\S+)$/);
  if (mkdir !== null) {
    const abs = insidePath(cwd, mkdir[1] ?? '');
    if (abs === null) return { ok: false, text: 'outside' };
    mkdirSync(abs, { recursive: true });
    return { ok: true, text: '' };
  }
  return { ok: true, text: '' };
};

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export function createMockBackend(mock: MockOptions): Backend {
  return {
    name: 'mock',
    start({ prompt, options }): QueryHandle {
      return { initializationResult: async () => ({ hooks_applied: hasHooks(options) }), [Symbol.asyncIterator]: () => run(prompt, options, mock) };
    },
  };
}

const hasHooks = (options: Options): boolean => (options.hooks?.PreToolUse?.length ?? 0) > 0;

async function* run(prompt: AsyncIterable<SDKUserMessage>, options: Options, mock: MockOptions): AsyncGenerator<unknown> {
  const cwd = options.cwd ?? '';
  const signal = options.abortController?.signal ?? new AbortController().signal;
  const sessionId = `mock-${mock.seed}`;
  const rng = seededRng(mock.seed);
  const model = options.model ?? 'mock-model';
  const hasRule = options.systemPrompt !== undefined && typeof options.systemPrompt === 'object' && 'append' in options.systemPrompt;
  const cumulative = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let toolSeq = 0;
  let turn = 0;

  yield { type: 'system', subtype: 'init', model, tools: MOCK_TOOLS, mcp_servers: [], claude_code_version: CLI_VERSION, permissionMode: options.permissionMode, cwd, session_id: sessionId };

  for await (const user of prompt) {
    turn += 1;
    const text = typeof user.message.content === 'string' ? user.message.content : '';
    const out: unknown[] = [];
    const turnUsage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const denials: { tool_name: string; tool_use_id: string }[] = [];
    let lastText = '';
    let calls = 0;
    const spend = (inTok: number, outTok: number): void => {
      turnUsage.input_tokens += inTok;
      turnUsage.output_tokens += outTok;
      turnUsage.cache_read_input_tokens += inTok * 4;
      cumulative.input += inTok;
      cumulative.output += outTok;
      cumulative.cacheRead += inTok * 4;
      cumulative.cacheWrite += Math.round(inTok / 2);
      cumulative.cost += inTok * 1e-6 + outTok * 5e-6 + inTok * 4 * 1e-7;
    };

    if (mock.hangOnTurn === turn) {
      mock.onHang?.(cwd);
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return;
    }

    const api: MockAgentApi = {
      say(t) {
        lastText = t;
        spend(300, 80 + Math.round(rng() * 60));
        out.push({ type: 'assistant', parent_tool_use_id: null, session_id: sessionId, message: { model, role: 'assistant', content: [{ type: 'text', text: t }] } });
      },
      async tool(name, input) {
        if (signal.aborted) throw new Error('aborted');
        calls += 1;
        toolSeq += 1;
        const id = `toolu_mock_${toolSeq}`;
        spend(500, 60 + Math.round(rng() * 40));
        out.push({ type: 'assistant', parent_tool_use_id: null, session_id: sessionId, message: { model, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
        const outcome = await callTool(options, cwd, sessionId, id, name, input, signal);
        if (outcome.blockedBy === 'hook_deny' || outcome.blockedBy === 'policy_deny') denials.push({ tool_name: name, tool_use_id: id });
        out.push({
          type: 'user',
          parent_tool_use_id: null,
          session_id: sessionId,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: !outcome.ok, content: outcome.text }] },
        });
        return outcome;
      },
    };

    await mock.behavior(api, { turn, prompt: text, hasRule, rng });
    for (const m of out) yield m;

    const maxTurns = options.maxTurns ?? Number.POSITIVE_INFINITY;
    const infra = mock.infraOnTurn === turn;
    const overTurns = calls + 1 > maxTurns;
    yield {
      type: 'result',
      subtype: overTurns ? 'error_max_turns' : 'success',
      is_error: infra || overTurns,
      api_error_status: infra ? 529 : null,
      duration_ms: 1500 + calls * 900,
      duration_api_ms: 1200 + calls * 700,
      num_turns: calls + 1,
      result: infra ? 'API Error: 529 overloaded' : lastText,
      stop_reason: 'end_turn',
      terminal_reason: overTurns ? 'max_turns' : infra ? 'api_error' : 'completed',
      total_cost_usd: Number(cumulative.cost.toFixed(6)),
      usage: { ...turnUsage },
      modelUsage: {
        [model]: {
          inputTokens: cumulative.input,
          outputTokens: cumulative.output,
          cacheReadInputTokens: cumulative.cacheRead,
          cacheCreationInputTokens: cumulative.cacheWrite,
          webSearchRequests: 0,
          costUSD: Number(cumulative.cost.toFixed(6)),
          contextWindow: 200000,
          maxOutputTokens: 64000,
        },
      },
      permission_denials: denials,
      uuid: `mock-result-${turn}`,
      session_id: sessionId,
    };
  }
}

async function callTool(
  options: Options,
  cwd: string,
  sessionId: string,
  toolUseId: string,
  name: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  const base = { session_id: sessionId, transcript_path: '', cwd, permission_mode: 'default' as const };
  const preMatchers = (options.hooks?.PreToolUse ?? []).filter((m) => matcherMatches(m, name));
  const outputs = await Promise.all(
    preMatchers.flatMap((m) =>
      m.hooks.map((h) => h({ ...base, hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: toolUseId }, toolUseId, { signal })),
    ),
  );
  const decisions = outputs.map(readHookDecision).filter((d): d is HookDecision => d !== null);
  const denied = decisions.find((d) => d.kind === 'deny');
  if (denied !== undefined) return { ok: false, text: denied.reason, blockedBy: 'hook_deny' };
  const asked = decisions.find((d) => d.kind === 'ask');

  let effectiveInput = input;
  const autoAllowed =
    asked === undefined && ((options.allowedTools ?? []).includes(name) || (name === 'Bash' && AUTO_READONLY_BASH.test(String(input.command ?? ''))));
  if (!autoAllowed) {
    const canUseTool = options.canUseTool;
    const answered =
      canUseTool === undefined
        ? null
        : await canUseTool(name, input, {
            signal,
            toolUseID: toolUseId,
            requestId: `req_${toolUseId}`,
            ...(asked === undefined ? {} : { decisionReason: asked.reason }),
          });
    // null 은 "호스트가 따로 답했다" — mock 에는 그런 경로가 없으므로 거부로 본다 (fail-closed)
    const decision: PermissionResult = answered ?? { behavior: 'deny', message: 'no permission handler' };
    if (decision.behavior === 'deny') return { ok: false, text: decision.message, blockedBy: 'policy_deny' };
    effectiveInput = decision.updatedInput ?? input;
  }

  const executed = execute(cwd, name, effectiveInput);
  const event = executed.ok ? 'PostToolUse' : 'PostToolUseFailure';
  for (const m of (options.hooks?.[event] ?? []).filter((mm) => matcherMatches(mm, name))) {
    for (const h of m.hooks) {
      await h(
        executed.ok
          ? { ...base, hook_event_name: 'PostToolUse', tool_name: name, tool_input: effectiveInput, tool_response: {}, tool_use_id: toolUseId }
          : { ...base, hook_event_name: 'PostToolUseFailure', tool_name: name, tool_input: effectiveInput, tool_use_id: toolUseId, error: executed.text },
        toolUseId,
        { signal },
      );
    }
  }
  return { ok: executed.ok, text: executed.text, blockedBy: executed.ok ? null : 'error' };
}

function execute(cwd: string, name: string, input: Record<string, unknown>): { ok: boolean; text: string } {
  const str = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '');
  try {
    switch (name) {
      case 'Write':
        return writeInside(cwd, str('file_path'), str('content')) ? { ok: true, text: 'File created' } : { ok: false, text: 'outside' };
      case 'Edit': {
        const abs = insidePath(cwd, str('file_path'));
        if (abs === null) return { ok: false, text: 'outside' };
        const before = readFileSync(abs, 'utf8');
        if (!before.includes(str('old_string'))) return { ok: false, text: 'String to replace not found in file.' };
        writeFileSync(abs, before.replace(str('old_string'), str('new_string')));
        return { ok: true, text: 'File updated' };
      }
      case 'Read': {
        const abs = insidePath(cwd, str('file_path'));
        return abs === null ? { ok: false, text: 'outside' } : { ok: true, text: readFileSync(abs, 'utf8') };
      }
      case 'Bash':
        return runMockBash(cwd, str('command'));
      case 'AskUserQuestion': {
        const answers = input.answers;
        return { ok: true, text: `User answered: ${JSON.stringify(answers ?? {})}` };
      }
      default:
        return { ok: true, text: '' };
    }
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
}
