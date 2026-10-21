// 대기 요청 코어 — IPC 패턴 4(블로킹 왕복)의 뼈대. 명세는 docs/SESSION.md 4.1절. **순수 모듈이다** — electron·log·fs 를 import 하지 않는다.
//
// 권한과 관문이 각자 인스턴스를 만든다. 공유하지 않는다.
// `ask` 가 돌려준 프라미스는 **어떤 경로로도 reject 하지 않는다**. 호출자(SDK 콜백)가 거부로 바꾼다.
// 모든 끝남 경로는 `settle` 하나를 거친다 — 대기 목록에서 **먼저 지운 뒤** 타이머·리스너를 정리하고 resolve 한다.
// 그래서 끝남 처리 도중(대기 수 알림 안)에 온 두 번째 응답도 대기 목록에서 찾지 못한다.

export type RoundTripOutcome<A> =
  | { readonly kind: 'answered'; readonly answer: A }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'closed' };

export interface RoundTripTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface RoundTripOptions<Q extends { readonly id: string }> {
  readonly timeoutMs: number;
  /** 질문을 렌더러로 보낸다. 던지면 그 요청은 곧바로 'closed' 로 끝난다. */
  readonly send: (question: Q) => void;
  /** 대기 수가 바뀔 때마다 부른다. 세션 상태의 permissions_pending 이 된다. */
  readonly onPendingChange?: (count: number) => void;
  /** 테스트가 가짜 타이머를 넣는다. 기본값 setTimeout/clearTimeout. */
  readonly timers?: RoundTripTimers;
}

export interface RoundTrip<Q extends { readonly id: string }, A> {
  ask(question: Q, signal?: AbortSignal): Promise<RoundTripOutcome<A>>;
  /** 모르는 id·이미 끝난 id 면 false. 같은 id 의 두 번째 응답은 무시된다. */
  answer(id: string, answer: A): boolean;
  /** 대기 중인 요청을 전부 'closed' 로 끝낸다. 창 닫힘·세션 종료·프로젝트 전환. */
  closeAll(): void;
  /** 그 id 하나를 'closed' 로 끝낸다. 모르는 id·이미 끝난 id 면 false. 질문을 가리다 실패했을 때. */
  cancel(id: string): boolean;
  readonly pendingCount: number;
}

interface PendingEntry<A> {
  readonly resolve: (outcome: RoundTripOutcome<A>) => void;
  /** 타이머를 지우고 abort 리스너를 뗀다. */
  readonly cleanup: () => void;
}

const DEFAULT_TIMERS: RoundTripTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const ABORTED: RoundTripOutcome<never> = Object.freeze({ kind: 'aborted' });
const TIMEOUT: RoundTripOutcome<never> = Object.freeze({ kind: 'timeout' });
const CLOSED: RoundTripOutcome<never> = Object.freeze({ kind: 'closed' });

export function createRoundTrip<Q extends { readonly id: string }, A>(options: RoundTripOptions<Q>): RoundTrip<Q, A> {
  const { timeoutMs, send, onPendingChange } = options;
  const timers = options.timers ?? DEFAULT_TIMERS;
  const pending = new Map<string, PendingEntry<A>>();

  /**
   * 알림이 던져도 삼킨다. 알림은 resolve 보다 먼저 돌므로, 던지게 두면 타이머가 지워진 채 요청이
   * 영원히 끝나지 않는다 — SDK 가 권한 콜백에서 멈춘다. 알림은 상태 표시일 뿐이고 결과가 우선이다.
   */
  const notifyPending = (): void => {
    try {
      onPendingChange?.(pending.size);
    } catch {
      // 상태 방송 실패는 요청의 결과를 막지 않는다
    }
  };

  /** 끝남 경로의 유일한 입구. 이미 끝난 id 면 false. `notify` 가 거짓이면 대기 수를 알리지 않는다 (closeAll 이 한 번에 알린다). */
  const settle = (id: string, outcome: RoundTripOutcome<A>, notify: boolean): boolean => {
    const entry = pending.get(id);
    if (entry === undefined) return false;
    pending.delete(id);
    entry.cleanup();
    if (notify) notifyPending();
    entry.resolve(outcome);
    return true;
  };

  // async 함수로 만들지 않는다 — 같은 id 의 중복 ask(프로그래머 오류)는 동기로 던지고, 돌려준 프라미스는 reject 하지 않는다.
  const ask = (question: Q, signal?: AbortSignal): Promise<RoundTripOutcome<A>> => {
    if (signal?.aborted === true) return Promise.resolve(ABORTED);
    const { id } = question;
    if (pending.has(id)) throw new Error(`round trip request ${id} is already pending`);

    const outcome = new Promise<RoundTripOutcome<A>>((resolve) => {
      const onAbort = (): void => {
        settle(id, ABORTED, true);
      };
      const handle = timers.set(() => {
        settle(id, TIMEOUT, true);
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.set(id, {
        resolve,
        cleanup: () => {
          timers.clear(handle);
          signal?.removeEventListener('abort', onAbort);
        },
      });
    });
    notifyPending();

    // 대기 목록에 넣은 뒤에 보낸다 — send 안에서 곧바로 온 응답도 찾을 수 있게.
    try {
      send(question);
    } catch {
      settle(id, CLOSED, true);
    }
    return outcome;
  };

  return {
    ask,
    answer: (id, answer) => settle(id, { kind: 'answered', answer }, true),
    closeAll: () => {
      if (pending.size === 0) return;
      for (const id of [...pending.keys()]) settle(id, CLOSED, false);
      notifyPending();
    },
    cancel: (id) => settle(id, CLOSED, true),
    get pendingCount() {
      return pending.size;
    },
  };
}
