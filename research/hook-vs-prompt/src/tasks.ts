// 과제 세트 읽기와 정적 최소 확인 (DESIGN v2 §3·§4.5). 앱을 띄우지 않는다 — 파일을 읽어 정규식만 본다.

import { cpSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type Stratum = 'new' | 'existing' | 'low-decision';

export interface TaskCheck {
  readonly anyFile?: readonly string[];
  readonly packageDependency?: string;
  readonly fileContains?: { readonly pattern: string; readonly files: string };
}

export interface TaskSpec {
  readonly id: string;
  readonly fixture: 'empty' | 'todo-web' | 'memo-cli' | 'downloads-mess';
  readonly stratum: Stratum;
  readonly promptKo: string;
  readonly openDecisions: readonly string[];
  readonly check: TaskCheck;
}

export interface TaskSet {
  readonly version: number;
  readonly pressureKo: string;
  readonly tasks: readonly TaskSpec[];
}

export function loadTaskSet(file: string): { set: TaskSet; raw: string } {
  const raw = readFileSync(file, 'utf8');
  const set = JSON.parse(raw) as TaskSet;
  if (!Array.isArray(set.tasks) || typeof set.pressureKo !== 'string') throw new Error('tasks.json 모양이 틀렸다');
  return { set, raw };
}

/** 픽스처를 실행 폴더로 복사한다. `empty` 는 아무것도 하지 않는다 (git init 도 하지 않는다). */
export function copyFixture(fixturesDir: string, fixture: TaskSpec['fixture'], runDir: string): void {
  if (fixture === 'empty') return;
  cpSync(path.join(fixturesDir, fixture), runDir, { recursive: true });
}

/** `(?i)` 접두를 i 플래그로 바꾼다 — tasks.json 을 사람이 읽기 쉽게. */
const toRegExp = (pattern: string): RegExp =>
  pattern.startsWith('(?i)') ? new RegExp(pattern.slice(4), 'i') : new RegExp(pattern);

/** 에피소드 끝 폴더에 대해 과제 최소 확인을 돌린다. `changed` 는 바뀐 경로(스냅샷 차이) — 기존 파일만으로는 통과하지 않게. */
export function runTaskCheck(check: TaskCheck, runDir: string, changed: readonly string[]): boolean {
  if (check.anyFile !== undefined) {
    const patterns = check.anyFile.map(toRegExp);
    if (!changed.some((p) => patterns.some((re) => re.test(p)))) return false;
  }
  if (check.packageDependency !== undefined) {
    const file = path.join(runDir, 'package.json');
    if (!existsSync(file)) return false;
    try {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      if (!(check.packageDependency in { ...pkg.dependencies, ...pkg.devDependencies })) return false;
    } catch {
      return false;
    }
  }
  if (check.fileContains !== undefined) {
    const files = toRegExp(check.fileContains.files);
    const pattern = toRegExp(check.fileContains.pattern);
    const hit = changed
      .filter((p) => files.test(p) && existsSync(path.join(runDir, p)))
      .some((p) => pattern.test(readFileSync(path.join(runDir, p), 'utf8')));
    if (!hit) return false;
  }
  return true;
}
