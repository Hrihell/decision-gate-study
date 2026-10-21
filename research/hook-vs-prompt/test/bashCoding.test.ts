import { describe, expect, it } from 'vitest';

import { buildCodingSheet, cohenKappa, recallByCode, collectBashCommands, mergeCodes, parseCsv, scoreCoding, sheetToCsv } from '../analysis/bashCoding';

// Bash 눈가림 코딩 (DESIGN §4.3, 변경 이력 N5 — 표본 100, 사람 1인, classifyBash 정밀도·재현율)
const bash = (id: string, command: string) => ({
  type: 'sdk_message',
  message: { type: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
});
const ep = (runId: string, cond: string, commands: string[]) => ({
  events: [{ type: 'run_meta', runId, cond }, ...commands.map((c, i) => bash(`${runId}-${i}`, c))],
});

const EPISODES = [
  ep('r1', 'A', ['ls -la', "cat > a.ts <<'EOF'\nx\nEOF", 'npm install']),
  ep('r2', 'C', ['ls -la', `node -e "require('fs').writeFileSync('a.ts','x')"`]),
  ep('r3', 'B', ['echo "a, b" > notes.txt']),
];

describe('collectBashCommands', () => {
  it('같은 명령은 하나로 묶고 나온 에피소드·조건을 모은다', () => {
    const c = collectBashCommands(EPISODES);
    expect(c).toHaveLength(5);
    expect(c.find((x) => x.command === 'ls -la')).toMatchObject({ runIds: ['r1', 'r2'], conds: ['A', 'C'] });
  });
});

describe('buildCodingSheet', () => {
  const c = collectBashCommands(EPISODES);

  it('시트에는 id·명령만 있다 — 조건·에피소드·휴리스틱 판정은 열쇠 파일로만 (눈가림)', () => {
    const { sheet, key } = buildCodingSheet(c, 10, 1);
    expect(sheet.every((r) => Object.keys(r).sort().join() === 'command,id')).toBe(true);
    expect(key.every((k) => 'conds' in k && 'heuristicWrites' in k)).toBe(true);
    expect(sheet.map((r) => r.id)).toEqual(key.map((k) => k.id));
  });

  it('n 보다 적으면 전부, 많으면 n 개만 — 같은 시드면 같은 표본', () => {
    expect(buildCodingSheet(c, 10, 1).sheet).toHaveLength(5);
    expect(buildCodingSheet(c, 3, 1).sheet).toHaveLength(3);
    expect(buildCodingSheet(c, 3, 7).sheet.map((r) => r.command)).toEqual(buildCodingSheet(c, 3, 7).sheet.map((r) => r.command));
  });

  it('휴리스틱은 heredoc 쓰기를 잡고 node -e 는 놓친다 — 열쇠에 그대로 남는다', () => {
    const { sheet, key } = buildCodingSheet(c, 10, 1);
    const hw = (cmd: string) => key[sheet.findIndex((r) => r.command === cmd)]?.heuristicWrites;
    expect(hw("cat > a.ts <<'EOF'\nx\nEOF")).toBe(true);
    expect(hw(`node -e "require('fs').writeFileSync('a.ts','x')"`)).toBe(false);
  });
});

describe('가린 자리표시자(<RUN_DIR> 등)는 리다이렉트가 아니다 — 로그는 가린 뒤라 그대로 휴리스틱에 넣으면 `>` 를 쓰기로 오인', () => {
  it('ls -la <RUN_DIR>/ 는 읽기, echo x > <RUN_DIR>/a.ts 는 쓰기', () => {
    const c = collectBashCommands([ep('r9', 'A', ['ls -la <RUN_DIR>/', 'find <HOME>/.claude -type f 2>/dev/null', 'echo x > <RUN_DIR>/a.ts'])]);
    const { sheet, key } = buildCodingSheet(c, 10, 1);
    const hw = (cmd: string) => key[sheet.findIndex((r) => r.command === cmd)]?.heuristicWrites;
    expect(hw('ls -la <RUN_DIR>/')).toBe(false);
    expect(hw('echo x > <RUN_DIR>/a.ts')).toBe(true);
  });
});

describe('CSV', () => {
  it('줄바꿈·따옴표·쉼표가 든 명령도 왕복한다', () => {
    const { sheet } = buildCodingSheet(collectBashCommands(EPISODES), 10, 1);
    const rows = parseCsv(sheetToCsv(sheet));
    expect(rows[0]).toEqual(['id', 'command', 'code']);
    expect(rows.slice(1).map((r) => r[1])).toEqual(sheet.map((r) => r.command));
    expect(rows.slice(1).every((r) => r[2] === '')).toBe(true);
  });
});

describe('scoreCoding', () => {
  it('사람 W-* 를 정답으로 휴리스틱 정밀도·재현율 — ? 와 빈칸은 뺀다', () => {
    const key = [
      { id: 'b1', heuristicWrites: true },
      { id: 'b2', heuristicWrites: false },
      { id: 'b3', heuristicWrites: true },
      { id: 'b4', heuristicWrites: false },
      { id: 'b5', heuristicWrites: true },
      { id: 'b6', heuristicWrites: false },
    ];
    const codes = new Map([
      ['b1', 'W-code'], // TP
      ['b2', 'W-code'], // FN (node -e 같은 누락)
      ['b3', 'R'], // FP
      ['b4', 'R'], // TN
      ['b5', '?'], // 제외
      // b6 빈칸 — 제외
    ]);
    const s = scoreCoding(codes, key);
    expect(s).toMatchObject({ n: 4, tp: 1, fp: 1, fn: 1, tn: 1, unknown: 1, uncoded: 1, precision: 0.5, recall: 0.5 });
  });

  it('모르는 코드는 오류로 알린다', () => {
    expect(() => scoreCoding(new Map([['b1', 'write']]), [{ id: 'b1', heuristicWrites: true }])).toThrow(/b1/);
  });
});

describe('두 코더 일치도와 불일치 판정 (N5 변경: LLM 코더 2 + 저자 판정)', () => {
  it('Cohen κ — 완전 일치 1, 우연 수준 0 근처, 공통 id 만 센다', () => {
    const a = new Map([['b1', 'R'], ['b2', 'W-code'], ['b3', 'R'], ['b4', 'W-code']]);
    expect(cohenKappa(a, new Map(a)).kappa).toBeCloseTo(1);
    const b = new Map([['b1', 'W-code'], ['b2', 'R'], ['b3', 'R'], ['b4', 'W-code'], ['b9', 'R']]);
    const k = cohenKappa(a, b);
    expect(k).toMatchObject({ n: 4, agree: 2 });
    expect(k.kappa).toBeCloseTo(0);
  });

  it('mergeCodes — 일치하면 그 코드, 불일치는 판정값, 판정이 없으면 목록으로 알린다', () => {
    const a = new Map([['b1', 'R'], ['b2', 'W-code']]);
    const b = new Map([['b1', 'R'], ['b2', 'W-other']]);
    expect(mergeCodes(a, b, new Map()).pending).toEqual(['b2']);
    const m = mergeCodes(a, b, new Map([['b2', 'W-code']]));
    expect(m.pending).toEqual([]);
    expect([...m.final]).toEqual([['b1', 'R'], ['b2', 'W-code']]);
  });
});

describe('recallByCode', () => {
  it('쓰기 범주마다 휴리스틱이 잡은 수', () => {
    const codes = new Map([['b1', 'W-code'], ['b2', 'W-code'], ['b3', 'W-scaffold'], ['b4', 'R']]);
    const key = [{ id: 'b1', heuristicWrites: true }, { id: 'b2', heuristicWrites: false }, { id: 'b3', heuristicWrites: false }, { id: 'b4', heuristicWrites: true }];
    expect(recallByCode(codes, key)).toEqual({ 'W-code': { detected: 1, n: 2 }, 'W-scaffold': { detected: 0, n: 1 } });
  });
});
