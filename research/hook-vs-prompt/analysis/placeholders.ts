// 로그는 가린 뒤라 명령에 <RUN_DIR>·<HOME> 같은 자리표시자가 들어 있다. 그대로 classifyBash 에 넣으면
// `<`·`>` 를 리다이렉트로 읽어 순수 읽기(`ls -la <RUN_DIR>/`)도 쓰기로 오인한다. 실제 관문은 가리기 전 경로를 봤다.
// 휴리스틱에 넣기 전에 자리표시자를 같은 모양의 중립 경로·값으로 되돌린다.

import { classifyBash } from '../../../src/main/gates/bashCommand';

const NEUTRAL: Readonly<Record<string, string>> = {
  RUN_DIR: '/run',
  HOME: '/home/u',
  OUTSIDE: '/outside',
  USER: 'u',
  EMAIL: 'e@example.com',
  SECRET: 'S',
};

export const neutralizePlaceholders = (command: string): string =>
  command.replace(/<(RUN_DIR|HOME|OUTSIDE|USER|EMAIL|SECRET)>/g, (_m, name: string) => NEUTRAL[name] ?? name);

/** 가린 명령에 대한 classifyBash — 분석에서는 이것만 쓴다. */
export const classifyLoggedBash = (command: string): ReturnType<typeof classifyBash> => classifyBash(neutralizePlaceholders(command));
