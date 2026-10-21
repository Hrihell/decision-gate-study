// 디스크 스냅샷과 차이 (DESIGN v2 §4.2, 리뷰 S5).
// 파일(경로·크기·sha256)과 **디렉터리**를 함께 훑는다 — 빈 `mkdir` 도 보인다. 심볼릭 링크는 따라가지 않는다.
// `.git`·`node_modules` 는 내용을 훑지 않고 플래그만. CLI 가 만들 수 있는 `.claude`, npm 캐시는 제외하고 플래그.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface FileEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly symlink?: true;
}

export interface Snapshot {
  readonly files: readonly FileEntry[];
  readonly dirs: readonly string[];
  readonly flags: { readonly gitDir: boolean; readonly nodeModules: boolean; readonly claudeDir: boolean; readonly npmCache: boolean };
}

/** 내용을 훑지 않는 폴더 → 플래그 이름 */
const FLAG_DIRS: ReadonlyMap<string, keyof Snapshot['flags']> = new Map([
  ['.git', 'gitDir'],
  ['node_modules', 'nodeModules'],
  ['.claude', 'claudeDir'],
  ['.npm-cache', 'npmCache'],
]);

export const NPM_CACHE_DIR = '.npm-cache';

export function takeSnapshot(root: string): Snapshot {
  const files: FileEntry[] = [];
  const dirs: string[] = [];
  const flags = { gitDir: false, nodeModules: false, claudeDir: false, npmCache: false };
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      const st = lstatSync(abs);
      if (st.isDirectory()) {
        const flag = FLAG_DIRS.get(name);
        if (flag !== undefined) {
          flags[flag] = true;
          continue;
        }
        dirs.push(rel);
        walk(abs);
      } else if (st.isSymbolicLink()) {
        files.push({ path: rel, size: 0, sha256: '', symlink: true });
      } else if (st.isFile()) {
        files.push({ path: rel, size: st.size, sha256: createHash('sha256').update(readFileSync(abs)).digest('hex') });
      }
    }
  };
  walk(root);
  return { files, dirs, flags };
}

export interface SnapshotDiff {
  readonly created: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly dirsCreated: readonly string[];
  readonly dirsDeleted: readonly string[];
}

export function diffSnapshots(before: Snapshot, after: Snapshot): SnapshotDiff {
  const a = new Map(before.files.map((f) => [f.path, f.sha256]));
  const b = new Map(after.files.map((f) => [f.path, f.sha256]));
  const da = new Set(before.dirs);
  const db = new Set(after.dirs);
  return {
    created: [...b.keys()].filter((p) => !a.has(p)),
    modified: [...b.keys()].filter((p) => a.has(p) && a.get(p) !== b.get(p)),
    deleted: [...a.keys()].filter((p) => !b.has(p)),
    dirsCreated: [...db].filter((d) => !da.has(d)),
    dirsDeleted: [...da].filter((d) => !db.has(d)),
  };
}

export const changedPaths = (d: SnapshotDiff): string[] => [...d.created, ...d.modified, ...d.deleted];

/** 실행 부산물 — 잠금 파일·캐시·빌드 출력·로그 (S5). V_disk_code 에서 뺀다. */
const BYPRODUCT = /(^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.DS_Store|__pycache__\/.*|\.next\/.*|dist\/.*|build\/.*|[^/]*\.pyc|[^/]*\.log)$/;
/** 소스·설정 파일 확장자 (S5) */
const SOURCE = /\.(?:html?|css|scss|[cm]?jsx?|tsx?|py|rb|go|rs|java|kt|swift|vue|svelte|sh|json|ya?ml|toml|md|sql|env|ipynb)$|(?:^|\/)(?:Dockerfile|Makefile|requirements\.txt)$/;

export const isByproduct = (p: string): boolean => BYPRODUCT.test(p);
export const isSourcePath = (p: string): boolean => !isByproduct(p) && SOURCE.test(p);
