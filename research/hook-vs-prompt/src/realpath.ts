// 심볼릭 링크를 따라간 실제 경로. safety hook 의 경로 판정이 쓴다 (safety.ts `realPathOf`).
//
// 아직 없는 경로(새 파일)는 가장 가까운 있는 조상의 realpath 뒤에 나머지를 붙인다.
// 대상이 없는 링크(dangling)는 readlink 로 대상을 풀어 따라간다 — Write 가 그 링크를 따라 밖에 쓸 수 있다.
// 링크가 너무 깊거나 고리면 undefined 가 아니라 판정 불가로 본다: 호출자는 undefined 를 "글자 판정만" 으로 쓰므로
// 여기서는 고리를 밖으로 보이게 루트(`/`)를 돌려준다.

import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';

const MAX_LINK_DEPTH = 32;

export function realPathOf(absolutePath: string, depth = 0): string | undefined {
  if (depth > MAX_LINK_DEPTH) return '/';
  const tail: string[] = [];
  let current = path.resolve(absolutePath);
  for (;;) {
    let isLink = false;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      tail.unshift(path.basename(current));
      current = parent;
      continue;
    }
    try {
      return path.join(realpathSync(current), ...tail);
    } catch {
      if (!isLink) return undefined;
      // 대상이 없는 링크 — 대상을 직접 풀어 따라간다
      const target = path.resolve(path.dirname(current), readlinkSync(current));
      const resolved = realPathOf(target, depth + 1);
      return resolved === undefined ? undefined : path.join(resolved, ...tail);
    }
  }
}
