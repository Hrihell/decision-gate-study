import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// 앱 `src/` 의 bare import 를 이 폴더의 node_modules 로 돌린다 (worktree 루트에 node_modules 가 없다).
const here = path.dirname(fileURLToPath(import.meta.url));
const dep = (name: string): string => path.join(here, 'node_modules', name);

export default defineConfig({
  resolve: {
    alias: {
      ajv: dep('ajv'),
    },
  },
  test: {
    root: here,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // 실제 Claude 호출 경로를 테스트가 켜지 못하게 한다 — live 백엔드는 이 두 값이 모두 있어야 열린다.
    env: { HVP_LIVE_CONFIRM: '' },
  },
});
