// 에이전트 질문(`AskUserQuestion`) 읽기·답 검사·SDK 결과. 명세는 docs/SESSION.md 4.4절, 결정은 ADR-025.
// **순수 모듈이다** — SDK 는 타입만 쓴다. electron·log·fs 를 import 하지 않는다 (ADR-017).
//
// SDK 입력도 렌더러의 답도 믿지 않는다. 모양이 틀리면 null 이고, 받은 객체를 펼치지 않고 필요한 필드만 골라 새로 만든다 —
// 그래야 선택지의 `preview` 가 렌더러로 새지 않고, 답에 끼운 모르는 키가 SDK 로 가지 않는다.
// 답을 고쳐서 받지 않는다(잘라 쓰기·모르는 label 버리기). 모델에게 가는 글이라 하나라도 틀리면 전부 버린다.
// 결과에 `updatedPermissions` 를 넣지 않는다 — 허용 규칙이 남은 세션 동안 `canUseTool` 을 가린다 (4.3절, ADR-011).

import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

import {
  QUESTION_COUNT_MAX,
  QUESTION_COUNT_MIN,
  QUESTION_FREE_TEXT_MAX_LENGTH,
  QUESTION_OPTION_COUNT_MAX,
  QUESTION_OPTION_COUNT_MIN,
  type AgentQuestion,
  type AgentQuestionOption,
  type QuestionAnswer,
  type QuestionRequest,
  type QuestionResponse,
} from '../../shared/ipc';
import type { RoundTripOutcome } from './roundTrip';

/** 모델이 읽는 거부 사유 (4.4 표). */
const DENY_MESSAGES = {
  dismissed: '사용자가 질문을 닫았어요. 필요하면 글로 다시 물어봐 주세요.',
  noAnswer: '답을 받지 못했어요. 글로 다시 물어봐 주세요.',
  unreadable: '질문 형식을 읽지 못했어요. 글로 물어봐 주세요',
} as const;

/** 입력을 읽지 못했을 때의 결과. */
export const UNREADABLE_QUESTION_RESULT: PermissionResult = Object.freeze({
  behavior: 'deny',
  message: DENY_MESSAGES.unreadable,
});

/** SDK 주석: 여러 개의 답은 쉼표로 잇는다. */
const ANSWER_SEPARATOR = ', ';

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFilledString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

const inRange = (length: number, min: number, max: number): boolean => length >= min && length <= max;

const hasDuplicates = (values: readonly string[]): boolean => new Set(values).size !== values.length;

/** 배열의 원소를 하나씩 읽는다. 하나라도 못 읽으면 null. */
function readAll<I, T>(items: readonly I[], read: (item: I) => T | null): T[] | null {
  const result: T[] = [];
  for (const item of items) {
    const value = read(item);
    if (value === null) return null;
    result.push(value);
  }
  return result;
}

const readOption = (raw: unknown): AgentQuestionOption | null => {
  if (!isPlainObject(raw)) return null;
  const { label, description } = raw;
  if (!isFilledString(label) || !isFilledString(description)) return null;
  return { label, description };
};

const readQuestion = (raw: unknown): AgentQuestion | null => {
  if (!isPlainObject(raw)) return null;
  const { question, header, multiSelect, options } = raw;
  if (!isFilledString(question) || !isFilledString(header) || typeof multiSelect !== 'boolean') return null;
  if (!Array.isArray(options) || !inRange(options.length, QUESTION_OPTION_COUNT_MIN, QUESTION_OPTION_COUNT_MAX)) {
    return null;
  }
  const parsed = readAll(options, readOption);
  // 같은 label 이 둘이면 사용자가 무엇을 골랐는지 가를 수 없다
  if (parsed === null || hasDuplicates(parsed.map((o) => o.label))) return null;
  return { question, header, multiSelect, options: parsed };
};

/** SDK 의 AskUserQuestion 입력을 읽는다. 모양이 틀리면 null. preview 는 버린다. */
export function parseAskUserQuestionInput(id: string, input: Record<string, unknown>): QuestionRequest | null {
  const { questions } = input;
  if (!Array.isArray(questions) || !inRange(questions.length, QUESTION_COUNT_MIN, QUESTION_COUNT_MAX)) return null;
  const parsed = readAll(questions, readQuestion);
  // `answers` 는 질문 글자를 키로 쓴다 — 같은 질문이 둘이면 답이 겹친다
  if (parsed === null || hasDuplicates(parsed.map((q) => q.question))) return null;
  return { id, questions: parsed };
}

/** 한 질문에 대한 답을 그 질문에 맞춰 검사한다. */
const readAnswer = (raw: unknown, question: AgentQuestion): QuestionAnswer | null => {
  if (!isPlainObject(raw)) return null;
  const { selected, freeText } = raw;
  if (typeof freeText !== 'string' || Array.from(freeText).length > QUESTION_FREE_TEXT_MAX_LENGTH) return null;
  if (!Array.isArray(selected) || !selected.every((s): s is string => typeof s === 'string')) return null;

  const labels = new Set(question.options.map((o) => o.label));
  if (!selected.every((s) => labels.has(s)) || hasDuplicates(selected)) return null;
  if (!question.multiSelect && selected.length > 1) return null;
  // 결과는 trim 한 글을 보낸다 — 공백뿐인 글은 빈 답이다
  if (selected.length === 0 && freeText.trim() === '') return null;

  return { question: question.question, selected: [...selected], freeText };
};

/** 요청의 질문마다 정확히 한 번씩 답이 있어야 한다. 빠짐·남음·겹침이면 null. */
const readAnswers = (raw: unknown, request: QuestionRequest): QuestionAnswer[] | null => {
  if (!Array.isArray(raw) || raw.length !== request.questions.length) return null;
  const byQuestion = new Map<string, unknown>();
  for (const item of raw) {
    if (!isPlainObject(item) || typeof item.question !== 'string' || byQuestion.has(item.question)) return null;
    byQuestion.set(item.question, item);
  }
  return readAll(request.questions, (q) => (byQuestion.has(q.question) ? readAnswer(byQuestion.get(q.question), q) : null));
};

/** 렌더러의 답 페이로드를 그 요청에 맞춰 검사한다. 하나라도 어기면 null — 응답 전체를 버린다. */
export function parseQuestionResponse(payload: unknown, request: QuestionRequest): QuestionResponse | null {
  if (!isPlainObject(payload) || payload.id !== request.id) return null;
  const { id } = request;
  if (payload.outcome === 'dismissed') return { id, outcome: 'dismissed' };
  if (payload.outcome !== 'answered') return null;
  const answers = readAnswers(payload.answers, request);
  return answers === null ? null : { id, outcome: 'answered', answers };
}

/** SDK 가 받는 모양: 질문 글자 → 고른 이름과 직접 적은 글을 쉼표로 이은 글. */
const toSdkAnswers = (answers: readonly QuestionAnswer[]): Record<string, string> =>
  Object.fromEntries(
    answers.map((a) => [a.question, [...a.selected, a.freeText.trim()].filter((s) => s !== '').join(ANSWER_SEPARATOR)]),
  );

/** SDK 로 돌려줄 결과. answered → allow + updatedInput.answers, 그 밖 → deny + 한국어 메시지. */
export function toQuestionResult(
  outcome: RoundTripOutcome<QuestionResponse>,
  originalInput: Record<string, unknown>,
): PermissionResult {
  switch (outcome.kind) {
    case 'answered': {
      const response = outcome.answer;
      if (response.outcome === 'dismissed') return { behavior: 'deny', message: DENY_MESSAGES.dismissed };
      return { behavior: 'allow', updatedInput: { ...originalInput, answers: toSdkAnswers(response.answers) } };
    }
    case 'timeout':
    case 'aborted':
    case 'closed':
      return { behavior: 'deny', message: DENY_MESSAGES.noAnswer };
  }
}
