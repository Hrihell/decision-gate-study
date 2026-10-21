// 도구 입력 읽기. 명세는 docs/GATES.md §6.3. **순수 모듈이다** — SDK·fs·electron 을 import 하지 않는다.
//
// 손으로 선언한 모양이다 — SDK 가 도구 입력 타입을 싣지 않는다 (`tool_input` 은 `unknown`,
// docs/ARCHITECTURE.md 함정 4). 런타임에 확인한 뒤에만 믿는다.

export type WriteToolInput = {
  readonly file_path: string;
  readonly content: string;
};

export type EditToolInput = {
  readonly file_path: string;
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all?: boolean;
};

/** NotebookEdit — `notebook_path` 다. `file_path` 가 아니다. */
export type NotebookEditToolInput = {
  readonly notebook_path: string;
  readonly new_source: string;
  readonly cell_id?: string;
  readonly cell_type?: 'code' | 'markdown';
  readonly edit_mode?: 'replace' | 'insert' | 'delete';
};

export type BashToolInput = {
  readonly command: string;
  readonly timeout?: number;
  readonly description?: string;
  readonly run_in_background?: boolean;
};

/**
 * 파일 쓰기 도구마다 대상 경로를 담는 **한 키**. 두 키를 도구와 무관하게 읽지 않는다 —
 * 키 혼동이 이 함정의 본질이다.
 */
const TARGET_PATH_KEY: ReadonlyMap<string, 'file_path' | 'notebook_path'> = new Map([
  ['Write', 'file_path'],
  ['Edit', 'file_path'],
  ['NotebookEdit', 'notebook_path'],
]);

/** 객체의 문자열 키 값. 입력이 객체가 아니거나(배열 포함), 값이 비었거나 공백뿐이면 undefined. 값은 자르지 않는다. */
const readNonBlankString = (input: unknown, key: string): string | undefined => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  if (!(key in input)) return undefined;
  const value: unknown = Reflect.get(input, key);
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value;
};

/** 파일 쓰기 도구의 대상 경로. 모르는 모양이면 undefined — "대상 없음" 이 아니라 "대상 모름" 이다. */
export function readTargetPath(toolName: string, toolInput: unknown): string | undefined {
  const key = TARGET_PATH_KEY.get(toolName);
  if (key === undefined) return undefined;
  return readNonBlankString(toolInput, key);
}

/** Bash 명령 문자열. 모르는 모양이면 undefined. */
export function readBashCommand(toolInput: unknown): string | undefined {
  return readNonBlankString(toolInput, 'command');
}
