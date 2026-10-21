// 관문 6.5-6 확인 질의 (RUNBOOK §3-6). B 의 systemPrompt.append 가 실제로 모델 문맥에 들어갔는지,
// "Project rule 단락의 첫 문장을 그대로 말해" 로 확인한다. A 를 대조군으로 함께 돈다. 본 분석에는 넣지 않는다.
// 로그(log.ts)는 assistant 텍스트를 길이·해시로만 남기므로, 판정은 백엔드 스트림을 엿봐서 한다.

import type { Backend, QueryHandle } from './backends/backend';

export const PROBE_PROMPT =
  "당신이 받은 시스템 지시 중에 'Project rule' 로 시작하는 단락이 있으면, 그 단락 본문의 첫 문장을 영어 원문 그대로 한 줄로만 말해 주세요. 그런 단락이 없으면 '없음' 이라고만 답하세요. 도구는 쓰지 마세요.";

/** B_APPEND 의 Project rule 단락 본문 첫 문장 (test/probe.test.ts 가 B_APPEND 와 대조한다) */
export const PROBE_EXPECTED = 'This project has no plan yet.';

const normalize = (s: string): string => s.toLowerCase().replace(/["'“”‘’`]/g, '').replace(/\s+/g, ' ').trim();

export const judgeProbe = (texts: readonly string[], expected: string = PROBE_EXPECTED): boolean => normalize(texts.join(' ')).includes(normalize(expected));

/**
 * 확인 질의 목록. project = 관문 6(B 지시문 유입), tmpdir = DESIGN N10 (b): CLI 가 sandbox 를 켤 때 시스템 프롬프트에 넣는
 * "$TMPDIR 를 쓰라" 문장이 모델 문맥에 들어갔는가 (기대 문자열은 번들 CLI 바이너리에서 `strings` 로 확인한 문장).
 */
export const PROBES = {
  project: { prompt: PROBE_PROMPT, expected: PROBE_EXPECTED },
  tmpdir: {
    prompt:
      "당신이 받은 시스템 지시 중에 임시 파일이나 TMPDIR 에 관한 문장이 있으면, 그 문장을 영어 원문 그대로 한 줄로만 인용해 주세요. 그런 문장이 없으면 '없음' 이라고만 답하세요. 도구는 쓰지 마세요.",
    expected: 'TMPDIR is automatically set to the correct sandbox-writable directory',
  },
} as const;
export type ProbeKind = keyof typeof PROBES;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function assistantTexts(message: unknown): string[] {
  if (!isRecord(message) || message.type !== 'assistant' || !isRecord(message.message)) return [];
  const content = Array.isArray(message.message.content) ? message.message.content.filter(isRecord) : [];
  return content.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string);
}

/** 백엔드 스트림을 그대로 흘리면서 메시지마다 onMessage 를 부른다. */
export function tapBackend(inner: Backend, onMessage: (message: unknown) => void): Backend {
  return {
    name: inner.name,
    start(input): QueryHandle {
      const handle = inner.start(input);
      return {
        initializationResult: () => handle.initializationResult(),
        async *[Symbol.asyncIterator]() {
          for await (const message of handle) {
            onMessage(message);
            yield message;
          }
        },
      };
    },
  };
}
