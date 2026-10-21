// 실제 Claude Agent SDK 백엔드. **이 Task 에서는 실행하지 않는다.** cli.ts 가 assertLiveAllowed 를 통과한 뒤에만 동적 import 한다.
// 테스트는 이 파일을 import 하지 않는다.

import type { Options } from '@anthropic-ai/claude-agent-sdk';

import type { Backend, QueryHandle } from './backend';

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk');

export function createLiveBackend(load: () => Promise<Sdk> = () => import('@anthropic-ai/claude-agent-sdk')): Backend {
  return {
    name: 'live',
    start({ prompt, options }): QueryHandle {
      const q = load().then((sdk) => sdk.query({ prompt, options }));
      return {
        initializationResult: async () => (await q).initializationResult(),
        async *[Symbol.asyncIterator]() {
          yield* await q;
        },
      };
    },
  };
}

/**
 * 실행 전 인증 확인 (리뷰 N2-1). 스트리밍 입력 query 하나를 열어 accountInfo() 만 부르고 닫는다 — 프롬프트를 보내지 않는다.
 * CLAUDE.md: 인증 여부는 `!accountInfo.email` 로 판정한다. **결과는 참·거짓만 돌려준다** — 이메일을 남기지 않는다 (M2).
 */
export async function checkAuthenticated(options: Options, sdk: Sdk): Promise<boolean> {
  let close: () => void = () => undefined;
  const prompt = (async function* () {
    await new Promise<void>((r) => {
      close = r;
    });
  })();
  const q = sdk.query({ prompt, options: { ...options, maxTurns: 1 } });
  try {
    const info = await q.accountInfo();
    return Boolean(info.email);
  } finally {
    close();
    q.close();
  }
}
