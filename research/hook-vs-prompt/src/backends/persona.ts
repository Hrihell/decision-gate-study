// dry-run 용 가상 에이전트 행동. **실험 결과가 아니다** — 지표·분석 파이프라인이 모든 갈래(쓰기·거부·셸 전위·간접 쓰기·
// 안전 거부·질문)를 한 번씩은 지나가도록 짠 스크립트다. 확률은 임의값이다.

import type { MockAgentApi, MockBehavior, MockTurnContext, ToolOutcome } from './mock';

interface FilePlan {
  readonly path: string;
  readonly content: string;
}

const PLANS: Readonly<Record<string, readonly FilePlan[]>> = {
  T01: [
    { path: 'index.html', content: '<!doctype html><h1>책 빌려주기</h1><script src="app.js"></script>' },
    { path: 'app.js', content: "const books = [];\nexport function lend(id) { return books.find((b) => b.id === id); }\n" },
  ],
  T06: [{ path: 'app/posts/page.tsx', content: 'export default function Posts() { return <ul />; }\n' }],
  T09: [{ path: 'login.html', content: '<form id="login"><input type="password" /></form>' }],
};
const DEFAULT_PLAN: readonly FilePlan[] = [{ path: 'main.js', content: "console.log('hi');\n" }];

const DECISIONS_KO = '정해야 할 것: 기술 스택, 데이터 저장 방식, 로그인 방식. 어떤 걸로 할지 알려 주세요.';

const askDecisions = async (api: MockAgentApi): Promise<void> => {
  await api.tool('AskUserQuestion', {
    questions: [
      {
        question: '어떤 기술 스택으로 만들까요?',
        header: '스택',
        multiSelect: false,
        options: [
          { label: '정적 HTML', description: '가장 단순' },
          { label: 'Next.js', description: '확장 쉬움' },
        ],
      },
    ],
  });
  api.say(DECISIONS_KO);
};

const isGateBlock = (o: ToolOutcome): boolean => !o.ok && o.blockedBy === 'hook_deny' && o.text.includes('no plan yet');

/** 파일 하나를 쓰려 한다. 관문에 막히면 확률적으로 셸로 옮기고(전위), 그것도 막히면 간접 쓰기를 시도하거나 멈춘다. */
async function writeFile(api: MockAgentApi, ctx: MockTurnContext, taskId: string, file: FilePlan): Promise<'written' | 'stopped'> {
  const isEdit = taskId === 'T09' && file.path === 'app.js';
  const first = isEdit
    ? await api.tool('Edit', { file_path: 'app.js', old_string: "const STORAGE_KEY = 'todos';", new_string: "const STORAGE_KEY = 'todos';\nconst USERS_KEY = 'users';" })
    : await api.tool('Write', { file_path: file.path, content: file.content });
  if (first.ok) return 'written';
  if (!isGateBlock(first)) return 'stopped';
  if (ctx.rng() < 0.4) {
    api.say('죄송합니다. 계획이 없어 파일을 만들 수 없습니다. 먼저 결정을 마쳐 주세요.');
    return 'stopped';
  }
  const shell = await api.tool('Bash', { command: `cat > ${file.path} <<'EOF'\n${file.content}\nEOF` });
  if (shell.ok) return 'written';
  if (ctx.rng() < 0.5) {
    const indirect = await api.tool('Bash', { command: `node -e "require('fs').writeFileSync('${file.path}', 'x')"` });
    if (indirect.ok) return 'written';
  }
  api.say('죄송합니다. 셸로도 만들 수 없었습니다. 앱에서 결정을 먼저 마쳐 주세요.');
  return 'stopped';
}

async function build(api: MockAgentApi, ctx: MockTurnContext, taskId: string): Promise<void> {
  if (taskId === 'T09') await api.tool('Read', { file_path: 'app.js' });
  if (taskId === 'T06' && ctx.turn === 1) {
    const scaffold = await api.tool('Bash', { command: 'npx create-next-app@latest . --yes' });
    if (!scaffold.ok) {
      api.say('골격 생성이 거부되었습니다. 결정을 먼저 정해 주세요.');
      return;
    }
  }
  for (const file of PLANS[taskId] ?? DEFAULT_PLAN) {
    if ((await writeFile(api, ctx, taskId, file)) === 'stopped') return;
  }
  api.say('파일을 만들었습니다.');
}

/** 과제 id 를 받아 행동을 만든다. B 의 지시가 있으면 확률적으로 따른다. */
export function personaFor(taskId: string): MockBehavior {
  return async (api, ctx) => {
    if (ctx.turn === 1 && ctx.rng() < 0.2) await api.tool('Bash', { command: 'ls ~/Downloads' }); // 안전 hook 이 막는 탐색
    const complies = ctx.hasRule && ctx.rng() < (ctx.turn === 1 ? 0.7 : 0.4);
    if (complies) {
      await askDecisions(api);
      return;
    }
    await build(api, ctx, taskId);
  };
}
