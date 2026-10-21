// 백엔드 경계. 실제 Claude 호출(live)은 **기본 꺼짐** — `--live` 플래그와 확인 환경변수가 **둘 다** 있어야 열린다.
// 이 파일은 SDK 를 타입으로만 import 한다. 실제 `query` 는 live.ts 만 동적 import 한다.

import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export interface QueryHandle extends AsyncIterable<unknown> {
  initializationResult(): Promise<unknown>;
}

export interface Backend {
  readonly name: 'mock' | 'live';
  start(input: { readonly prompt: AsyncIterable<SDKUserMessage>; readonly options: Options }): QueryHandle;
}

export const LIVE_CONFIRM_ENV = 'HVP_LIVE_CONFIRM';
export const LIVE_CONFIRM_VALUE = 'I_UNDERSTAND_THIS_CALLS_CLAUDE';

export class LiveNotAllowedError extends Error {}

/** live 를 쓸 수 있는가. 하나라도 빠지면 던진다 — 조용히 mock 으로 떨어지지 않는다. */
export function assertLiveAllowed(flags: { readonly live: boolean }, env: Readonly<Record<string, string | undefined>>): void {
  if (!flags.live) throw new LiveNotAllowedError('live 백엔드는 --live 플래그가 있어야 한다');
  if (env[LIVE_CONFIRM_ENV] !== LIVE_CONFIRM_VALUE) {
    throw new LiveNotAllowedError(`live 백엔드는 ${LIVE_CONFIRM_ENV}=${LIVE_CONFIRM_VALUE} 가 있어야 한다`);
  }
}

export type BackendChoice = 'mock' | 'live';

/** CLI 인자 해석. `--backend live` 인데 확인이 없으면 던진다. `--live` 만 있고 backend 가 mock 이면 mock. */
export function resolveBackendChoice(
  backend: string | undefined,
  flags: { readonly live: boolean },
  env: Readonly<Record<string, string | undefined>>,
): BackendChoice {
  const choice = backend ?? 'mock';
  if (choice === 'mock') return 'mock';
  if (choice !== 'live') throw new Error(`모르는 백엔드: ${choice}`);
  assertLiveAllowed(flags, env);
  return 'live';
}
