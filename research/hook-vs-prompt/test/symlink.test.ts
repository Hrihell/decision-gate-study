// safety hook 의 심볼릭 링크 탈출 — 글자로는 실행 폴더 안이지만 링크가 밖을 가리키는 경로.
// 실제 임시 폴더와 링크를 만든다 (realpath 는 디스크를 봐야 한다).

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { realPathOf } from '../src/realpath';
import { decideSafety } from '../src/safety';

let runDir = '';
let outside = '';

beforeAll(() => {
  runDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hvp-sym-run-')));
  outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hvp-sym-out-')));
  writeFileSync(path.join(outside, 'secret.txt'), 'not for the agent');
  writeFileSync(path.join(runDir, 'own.txt'), 'inside');
  mkdirSync(path.join(runDir, 'src'));
  symlinkSync(outside, path.join(runDir, 'out')); // 폴더 링크 → 밖
  symlinkSync(path.join(outside, 'missing.txt'), path.join(runDir, 'dangling')); // 대상 없는 링크 → 밖
  symlinkSync(path.join(runDir, 'src'), path.join(runDir, 'alias')); // 안 → 안
  symlinkSync(path.join(runDir, 'loop-b'), path.join(runDir, 'loop-a'));
  symlinkSync(path.join(runDir, 'loop-a'), path.join(runDir, 'loop-b'));
});

afterAll(() => {
  rmSync(runDir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const judge = (toolName: string, toolInput: Record<string, unknown>) =>
  decideSafety({ toolName, toolInput, cwd: runDir, runDir, readFileText: () => undefined, realPathOf });

describe('심볼릭 링크로 밖을 가리키는 경로는 거부한다', () => {
  it.each([
    ['Read: 폴더 링크 속 파일', 'Read', { file_path: 'out/secret.txt' }],
    ['Read: 폴더 링크 속 파일 (절대 경로)', 'Read', () => ({ file_path: path.join(runDir, 'out', 'secret.txt') })],
    ['Write: 폴더 링크 속 새 파일', 'Write', { file_path: 'out/new.txt', content: 'x' }],
    ['Edit: 폴더 링크 속 파일', 'Edit', { file_path: 'out/secret.txt', old_string: 'a', new_string: 'b' }],
    ['Write: 대상 없는 링크', 'Write', { file_path: 'dangling', content: 'x' }],
    ['Glob: path 가 링크', 'Glob', { pattern: '**/*', path: 'out' }],
    ['Glob: 패턴 고정부가 링크', 'Glob', { pattern: 'out/**/*.txt' }],
    ['Grep: path 가 링크', 'Grep', { pattern: 'x', path: 'out' }],
    ['Read: 고리 링크', 'Read', { file_path: 'loop-a/x' }],
  ] as const)('%s', (_label, toolName, input) => {
    const toolInput = typeof input === 'function' ? input() : input;
    expect(judge(toolName, toolInput as Record<string, unknown>)).toEqual({ kind: 'deny', rule: 'path_outside' });
  });
});

describe('안을 가리키는 경로는 그대로 허용한다', () => {
  it.each([
    ['Read: 보통 파일', 'Read', { file_path: 'own.txt' }],
    ['Write: 아직 없는 하위 폴더의 새 파일', 'Write', { file_path: 'new/deep/file.ts', content: 'x' }],
    ['Write: 안을 가리키는 링크 속 새 파일', 'Write', { file_path: 'alias/app.ts', content: 'x' }],
    ['Glob: 실행 폴더 전체', 'Glob', { pattern: '**/*.ts' }],
  ] as const)('%s', (_label, toolName, input) => {
    expect(judge(toolName, input as Record<string, unknown>)).toEqual({ kind: 'allow' });
  });
});

describe('realPathOf', () => {
  it('없는 경로는 가장 가까운 조상의 realpath 뒤에 나머지를 붙인다', () => {
    expect(realPathOf(path.join(runDir, 'new', 'a.ts'))).toBe(path.join(runDir, 'new', 'a.ts'));
  });
  it('대상 없는 링크는 대상을 따라간다', () => {
    expect(realPathOf(path.join(runDir, 'dangling'))).toBe(path.join(outside, 'missing.txt'));
  });
  it('고리는 루트(/) 아래로 풀어 밖으로 본다', () => {
    expect(realPathOf(path.join(runDir, 'loop-a', 'x'))).toBe('/x');
  });
});
