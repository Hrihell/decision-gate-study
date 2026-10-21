import type { Recorder } from '../src/log';

/** 메모리 기록자. 가리기는 하지 않는다 — 가리기 테스트는 따로 있다. */
export function memoryRecorder(): Recorder & { readonly events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = [];
  return {
    events,
    redact: (t) => t,
    write(event) {
      events.push({ ...event });
    },
  };
}
