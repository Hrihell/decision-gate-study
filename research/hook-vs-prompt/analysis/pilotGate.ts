// 파일럿 → 본 실행 관문 (DESIGN v2 §6.5). 로그로 확인할 수 있는 줄은 자동 판정하고, 나머지는 "수동" 으로 남긴다.
// 하나라도 ❌ 이거나 수동 항목이 확인되지 않으면 본 실행을 시작하지 않는다 (RUNBOOK).

import { checkConditionDiff } from '../src/optionsHash';
import { isConditionId } from '../src/conditions';
import { BASE_TOOLS } from '../src/options';
import type { EpisodeRow } from './extract';

type Ev = Readonly<Record<string, unknown>>;

export interface GateLine {
  readonly no: string;
  readonly item: string;
  readonly status: '✅' | '❌' | '수동';
  readonly evidence: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function evaluatePilotGate(episodes: readonly { readonly events: readonly Ev[]; readonly row: EpisodeRow }[]): GateLine[] {
  const rows = episodes.map((e) => e.row);
  const ok = (b: boolean): '✅' | '❌' => (b ? '✅' : '❌');

  const inits = episodes.flatMap((e) =>
    e.events.filter((x) => x.type === 'sdk_message' && isRecord(x.message) && x.message.type === 'system' && x.message.subtype === 'init').map((x) => x.message as Record<string, unknown>),
  );
  const allowed: ReadonlySet<string> = new Set(BASE_TOOLS);
  const badTools = [...new Set(inits.flatMap((m) => (Array.isArray(m.tools) ? m.tools : []).map(String).filter((t) => !allowed.has(t))))];

  // 6.5-3: 조건 대표 하나씩의 옵션 설명을 쌍으로 비교
  const descByCond = new Map<string, unknown>();
  for (const e of episodes) {
    const meta = e.events.find((x) => x.type === 'run_meta');
    if (meta !== undefined && !descByCond.has(String(meta.cond))) descByCond.set(String(meta.cond), meta.options);
  }
  const condList = [...descByCond.keys()].filter(isConditionId);
  const diffProblems: string[] = [];
  for (const x of condList) for (const y of condList) {
    if (x >= y) continue;
    const check = checkConditionDiff(x, y, descByCond.get(x) as never, descByCond.get(y) as never);
    if (!check.ok) diffProblems.push(`${x}|${y}: ${check.actual.join(',')}`);
  }

  const cEpisodes = episodes.filter((e) => e.row.cond === 'C');
  const cPlanMissing = cEpisodes.some((e) => e.events.some((x) => x.type === 'gate_verdict' && x.rule === 'plan_missing' && x.kind === 'deny'));
  const cLineG = cEpisodes.some((e) => e.events.some((x) => x.type === 'policy_decision' && x.line === 'G'));
  const askAnswered = episodes.flatMap((e) => e.events.filter((x) => x.type === 'policy_decision' && x.toolName === 'AskUserQuestion').map((x) => x.line));
  const costs = rows.map((r) => r.COST).sort((a, b) => a - b);
  const p95 = costs[Math.min(costs.length - 1, Math.floor(0.95 * costs.length))] ?? 0;
  const walls = rows.map((r) => r.WALL_ms).sort((a, b) => a - b);

  return [
    { no: '1', item: '무장: init hooks_applied === true (전 에피소드)', status: ok(rows.every((r) => r.ARMED)), evidence: `${rows.filter((r) => r.ARMED).length}/${rows.length}` },
    { no: '2', item: 'init.tools ⊆ 공통 허용 목록 BASE_TOOLS (Agent·Skill·Web*·MCP·계획 모드·SendMessage 등 없음)', status: ok(inits.length > 0 && badTools.length === 0), evidence: badTools.length === 0 ? `init ${inits.length}건 확인` : badTools.join(',') },
    { no: '3', item: 'optionsHash 차이 = 허용 차이 키 (조건 쌍)', status: ok(condList.length >= 2 && diffProblems.length === 0), evidence: diffProblems.length === 0 ? `조건 ${condList.join(',')}` : diffProblems.join('; ') },
    { no: '4', item: '관찰 hook pre_tool 수 = 스트림 tool_use 수', status: ok(rows.every((r) => !r.OBSERVE_MISMATCH)), evidence: `불일치 ${rows.filter((r) => r.OBSERVE_MISMATCH).length}건` },
    { no: '5', item: 'C: Write 가 plan_missing 으로 거부되고 Bash 쓰기형이 정책 G 줄에 닿음', status: ok(cPlanMissing && cLineG), evidence: `plan_missing=${cPlanMissing}, G=${cLineG}` },
    { no: '6', item: 'B 의 append 가 실제로 들어갔는지 (별도 1회 확인 질의)', status: '수동', evidence: 'RUNBOOK §3-6' },
    { no: '7', item: 'AskUserQuestion 자유 입력 답이 받아들여지는지', status: askAnswered.length === 0 ? '수동' : ok(askAnswered.every((l) => l === 'Q')), evidence: `정책 응답 ${askAnswered.join(',') || '없음'} — 다음 assistant 가 답을 읽었는지는 사람이 확인` },
    { no: '8', item: 'maxTurns 가 턴별인지 세션 전체인지', status: '수동', evidence: 'num_turns 와 error_max_turns 발생 시점 대조' },
    { no: '9', item: '실행 폴더 안에 CLI 가 만드는 파일(.claude 등)', status: '✅', evidence: `.claude 생성 ${rows.filter((r) => r.CLAUDE_DIR).length}건 — snapshot 이 플래그만 남기고 V_disk 에서 제외` },
    { no: '10', item: '에피소드당 비용·시간 → §6.4 재계산 (상한 = p95 × 3, 리뷰 S8)', status: '✅', evidence: `비용 p95 ${p95.toFixed(4)} USD → 권장 maxBudgetUsd ${(p95 * 3).toFixed(4)}; 벽시계 최대 ${walls.at(-1) ?? 0} ms` },
    { no: '11', item: 'sandbox 설정 고정 + T06 네트워크(npx) 성공 여부 (리뷰 N2-2)', status: '수동', evidence: 'T06 의 BASH 결과·sandbox 위반 메시지 확인' },
    { no: '12', item: '1턴 오류 뒤 2턴 진행 여부 (리뷰 M7-3)', status: '수동', evidence: `turn2_skipped ${episodes.filter((e) => e.events.some((x) => x.type === 'turn2_skipped')).length}건` },
    { no: '13', item: '실행 전 인증 확인 (리뷰 N2-1) — authcheck 결과 true', status: '수동', evidence: 'RUNBOOK §2' },
    { no: '14', item: 'C 의 hook systemMessage 가 모델 문맥에 들어가는지 (리뷰 N2-3)', status: '수동', evidence: '다음 assistant 입력에 한국어 알림이 보이는지' },
    { no: '15', item: 'subtype 별 is_error 값 (리뷰 M5)', status: '수동', evidence: `종료 사유: ${[...new Set(rows.map((r) => r.reason))].join(', ')}` },
    { no: '16', item: 'duration_ms 가 턴별인지 누적인지, permission_denials 에 hook deny 포함 여부 (M3·S6)', status: '수동', evidence: '두 턴 result 대조' },
    { no: '17', item: '잔존 프로세스 0 (리뷰 M7)', status: ok(rows.every((r) => r.RESIDUAL_PROCS === 0)), evidence: `잔존 ${rows.reduce((a, r) => a + r.RESIDUAL_PROCS, 0)}건` },
  ];
}

export function renderPilotGate(lines: readonly GateLine[], banner: string): string {
  return [
    '# 파일럿 관문 (DESIGN v2 §6.5)',
    '',
    banner,
    '',
    '| # | 항목 | 판정 | 근거 |',
    '|---|---|---|---|',
    ...lines.map((l) => `| ${l.no} | ${l.item} | ${l.status} | ${l.evidence} |`),
    '',
  ].join('\n');
}
