import { describe, expect, it } from 'vitest';

import { extractEpisode } from '../analysis/extract';
import { evaluatePilotGate } from '../analysis/pilotGate';

// 관문 2: init.tools 는 공통 허용 목록(BASE_TOOLS)과 같아야 한다 — 파일럿에서 SendMessage·Workflow·EnterPlanMode 가 열려 있었다.
const episode = (tools: string[], claudeDir = false) => {
  const events = [
    { type: 'run_meta', runId: 'r', block: 1, task: 'T01', stratum: 'new', cond: 'A', rep: 1, rerunOf: null, backend: 'mock', options: {} },
    { type: 'sdk_message', message: { type: 'system', subtype: 'init', tools } },
    { type: 'init_result', hooks_applied: true },
    { type: 'snapshot', at: 't_end', files: [], dirs: [], flags: { gitDir: false, nodeModules: false, claudeDir, npmCache: false } },
    { type: 'run_end', outcome: 'ok', reason: 'ok', t: 1 },
  ];
  return { events, row: extractEpisode(events) };
};
const BASE = ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep', 'Bash', 'AskUserQuestion', 'TaskOutput', 'TaskStop'];
const line = (no: string, eps: ReturnType<typeof episode>[]) => evaluatePilotGate(eps).find((l) => l.no === no);

describe('파일럿 관문 2 — init.tools 허용 목록', () => {
  it('허용 목록과 같으면 통과', () => {
    expect(line('2', [episode(BASE)])?.status).toBe('✅');
  });
  it.each(['SendMessage', 'EnterPlanMode', 'ToolSearch', 'Workflow', 'mcp__x__y'])('%s 가 있으면 실패하고 이름을 근거에 남긴다', (extra) => {
    const l = line('2', [episode([...BASE, extra])]);
    expect(l?.status).toBe('❌');
    expect(l?.evidence).toContain(extra);
  });
});

describe('파일럿 관문 9 — CLI 가 만드는 .claude 는 snapshot 이 제외한다', () => {
  it('.claude 가 생겨도 통과로 보고 건수를 근거에 남긴다', () => {
    const l = line('9', [episode(BASE, true)]);
    expect(l?.status).toBe('✅');
    expect(l?.evidence).toContain('1건');
  });
});
