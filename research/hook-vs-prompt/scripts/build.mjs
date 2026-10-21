// cli.ts 를 단일 .mjs 로 묶는다. 앱 `src/` 의 bare import(ajv)는 이 폴더의 node_modules 에서 찾는다.
// SDK 는 묶지 않는다 — live 백엔드가 동적 import 할 때만 읽힌다.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

await build({
  entryPoints: [path.join(here, 'src/cli.ts')],
  outfile: path.join(here, 'dist/cli.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  nodePaths: [path.join(here, 'node_modules')],
  external: ['@anthropic-ai/claude-agent-sdk'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});
