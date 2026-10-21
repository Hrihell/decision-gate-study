// 스트리밍 입력 채널. 메인 프로세스가 세션 수명 동안 소유한다.
//
// **모든 세션은 스트리밍 입력이다** (docs/ARCHITECTURE.md 세션 모델).
// `prompt` 를 문자열로 넘기면 `accountInfo()`·`interrupt()`·`setPermissionMode()` 가
// 동작하지 않는다 — 그 셋은 제어 요청이고 제어 요청은 스트리밍 입출력에서만
// 지원된다 (`sdk.d.ts` L2611-2614).
//
// 이 모듈은 SDK 를 **타입으로만** import 한다. 그래서 서브프로세스 없이 테스트된다.

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export type InputChannel = {
  /** `query({ prompt })` 에 그대로 넘긴다. */
  readonly stream: AsyncIterable<SDKUserMessage>;
  /** 사용자 턴을 큐에 넣는다. `close()` 이후의 호출은 무시된다. */
  push(text: string): void;
  /** 스트림을 끝낸다. 이것을 부르기 전까지 `stream` 은 절대 반환하지 않는다. */
  close(): void;
};

/**
 * 큐 + 프라미스 핸드오프 방식의 async generator 를 만든다.
 *
 * **유휴 상태에서 소진되지 않는 것이 이 함수의 전부다.** 큐가 비었을 때 generator 가
 * 반환하면 SDK 는 세션이 끝난 것으로 보고, 증상은 "첫 턴 이후 에이전트가 조용히
 * 대답하지 않음" 으로만 나타난다. 그래서 `close()` 될 때까지 프라미스에서 대기한다.
 */
export const createInputChannel = (): InputChannel => {
  const queue: SDKUserMessage[] = [];
  let notify: (() => void) | undefined;
  let closed = false;

  const push = (text: string): void => {
    if (closed) return;
    queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      // `uuid` 와 `session_id` 는 넣지 않는다. 우리가 만들 값이 아니다.
    });
    notify?.();
  };

  const close = (): void => {
    closed = true;
    notify?.();
  };

  const stream = (async function* (): AsyncGenerator<SDKUserMessage, void> {
    for (;;) {
      for (;;) {
        const next = queue.shift();
        if (next === undefined) break;
        yield next;
      }
      // 닫혔더라도 큐를 먼저 비운 뒤에 끝낸다. 아니면 마지막 턴이 유실된다.
      if (closed) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
      notify = undefined;
    }
  })();

  return { stream, push, close };
};
