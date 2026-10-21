// 에피소드 하나의 옵션 조립 — hooks·정책·옵션·해시를 한 곳에서. episode.ts 와 테스트가 같은 경로를 쓴다.

import type { Options, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

import type { ConditionSpec } from './conditions';
import { buildHooks } from './hooks';
import type { Recorder } from './log';
import { buildExperimentOptions } from './options';
import { describeOptions, hashOptions, labelFn } from './optionsHash';
import { createPolicy } from './policy';

export interface AssembleInput {
  readonly condition: ConditionSpec;
  readonly runDir: string;
  readonly recorder: Recorder;
  readonly turn: () => number;
  readonly readFileText: (absolutePath: string) => string | undefined;
  readonly model: string;
  readonly maxBudgetUsd: number;
  readonly env: Readonly<Record<string, string>>;
  readonly authKeys: readonly string[];
  readonly abortController: AbortController;
  readonly spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
}

export interface Assembled {
  readonly options: Options;
  /** 함수·env 값·runDir 이 없는 설명 — run_meta.options 에 그대로 쓴다 */
  readonly description: ReturnType<typeof describeOptions>;
  readonly optionsHash: string;
}

export function assembleOptions(input: AssembleInput): Assembled {
  const hooks = buildHooks(input);
  const canUseTool = labelFn(
    createPolicy({
      bashAsk: input.condition.bashAsk,
      onDecision: (r) => input.recorder.write({ type: 'policy_decision', ...r }),
    }),
    `policy(ask=${input.condition.bashAsk})`,
  );
  const options = buildExperimentOptions({
    condition: input.condition,
    runDir: input.runDir,
    model: input.model,
    maxBudgetUsd: input.maxBudgetUsd,
    hooks,
    canUseTool,
    abortController: input.abortController,
    env: input.env,
    authKeys: input.authKeys,
    ...(input.spawnClaudeCodeProcess === undefined ? {} : { spawnClaudeCodeProcess: labelFn(input.spawnClaudeCodeProcess, 'spawn.group') }),
  });
  const description = describeOptions(options, input.runDir);
  return { options, description, optionsHash: hashOptions(description) };
}
