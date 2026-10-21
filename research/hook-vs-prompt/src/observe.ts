// 관찰 hook (DESIGN v2 §2.5). 세 조건 공통. **항상 `{}`** 를 돌려주고 절대 throw 하지 않는다 —
// 던지는 hook 은 조건마다 다른 흐름을 만들 수 있다 (TESTING L138 #12a). 실패는 observe_error 로만 남긴다.
// PostToolUseFailure 에도 단다 — 실행이 실패한 호출에는 PostToolUse 가 오지 않는다 (리뷰 S6).

import type { HookCallback, HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';

import { classifyBash } from '../../../src/main/gates/bashCommand';
import type { Recorder } from './log';
import { summarizeToolInput } from './log';
import { labelFn } from './optionsHash';

export interface ObserveDeps {
  readonly recorder: Recorder;
  readonly runDir: string;
  readonly turn: () => number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function createObserveHooks(deps: ObserveDeps): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const { recorder, runDir } = deps;
  const guard =
    (where: string, body: Parameters<HookCallback>[0] extends infer I ? (input: I, id: string | undefined) => void : never): HookCallback =>
    async (input, toolUseId) => {
      try {
        body(input, toolUseId);
      } catch (error) {
        recorder.write({ type: 'observe_error', where, message: error instanceof Error ? error.message : String(error) });
      }
      return {};
    };

  const pre = guard('pre_tool', (input, toolUseId) => {
    if (input.hook_event_name !== 'PreToolUse') return;
    const summary = summarizeToolInput(input.tool_name, input.tool_input, runDir, recorder.redact);
    const command = input.tool_name === 'Bash' && isRecord(input.tool_input) ? input.tool_input.command : undefined;
    recorder.write({
      type: 'pre_tool',
      turn: deps.turn(),
      toolUseId: toolUseId ?? input.tool_use_id,
      tool: input.tool_name,
      agentId: input.agent_id ?? null,
      input: summary,
      ...(typeof command === 'string' ? { bash: classifyBash(command) } : {}),
    });
  });

  const post = guard('post_tool', (input, toolUseId) => {
    if (input.hook_event_name !== 'PostToolUse') return;
    recorder.write({ type: 'post_tool', turn: deps.turn(), toolUseId: toolUseId ?? input.tool_use_id, tool: input.tool_name });
  });

  const fail = guard('post_tool_failure', (input, toolUseId) => {
    if (input.hook_event_name !== 'PostToolUseFailure') return;
    recorder.write({ type: 'post_tool_failure', turn: deps.turn(), toolUseId: toolUseId ?? input.tool_use_id, tool: input.tool_name });
  });

  return {
    PreToolUse: [{ hooks: [labelFn(pre, 'observe.pre')] }],
    PostToolUse: [{ hooks: [labelFn(post, 'observe.post')] }],
    PostToolUseFailure: [{ hooks: [labelFn(fail, 'observe.fail')] }],
  };
}
