// Bash 눈가림 코딩 (DESIGN §4.3, 변경 이력 N5). classifyBash 는 시험 대상의 일부라 정답으로 쓸 수 없다 —
// 사람이 조건을 모른 채 명령 표본을 코딩하고, 그 정답에 대한 휴리스틱의 정밀도·재현율을 낸다.
// 시트(코더가 보는 파일)에는 id·명령만 둔다. 조건·에피소드·휴리스틱 판정은 열쇠 파일로만 나간다.

import { classifyLoggedBash } from './placeholders';

type Ev = Readonly<Record<string, unknown>>;

export const CODES = ['W-code', 'W-scaffold', 'W-other', 'W-harness', 'R', '?'] as const;

export interface CollectedCommand {
  readonly command: string;
  readonly runIds: readonly string[];
  readonly conds: readonly string[];
}

export interface SheetRow {
  readonly id: string;
  readonly command: string;
}

export interface KeyRow {
  readonly id: string;
  readonly runIds: readonly string[];
  readonly conds: readonly string[];
  readonly heuristicWrites: boolean;
}

export interface CodingScore {
  readonly n: number;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly tn: number;
  readonly unknown: number;
  readonly uncoded: number;
  readonly precision: number | null;
  readonly recall: number | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const bashCommandsOf = (events: readonly Ev[]): string[] =>
  events.flatMap((e) => {
    if (e.type !== 'sdk_message' || !isRecord(e.message) || e.message.type !== 'assistant') return [];
    const content = Array.isArray(e.message.content) ? e.message.content.filter(isRecord) : [];
    return content.filter((b) => b.type === 'tool_use' && b.name === 'Bash' && isRecord(b.input) && typeof b.input.command === 'string').map((b) => (b.input as { command: string }).command);
  });

/** 에피소드들의 Bash 명령을 중복 제거한다. 처음 나온 순서를 지킨다. */
export function collectBashCommands(episodes: readonly { readonly events: readonly Ev[] }[]): CollectedCommand[] {
  const byCommand = new Map<string, { runIds: string[]; conds: string[] }>();
  for (const { events } of episodes) {
    const meta = events.find((e) => e.type === 'run_meta') ?? {};
    const runId = String(meta.runId ?? '');
    const cond = String(meta.cond ?? '');
    for (const command of bashCommandsOf(events)) {
      const entry = byCommand.get(command) ?? { runIds: [], conds: [] };
      byCommand.set(command, {
        runIds: entry.runIds.includes(runId) ? entry.runIds : [...entry.runIds, runId],
        conds: entry.conds.includes(cond) ? entry.conds : [...entry.conds, cond],
      });
    }
  }
  return [...byCommand].map(([command, v]) => ({ command, ...v }));
}

const rngFrom = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** 시드 고정으로 섞은 뒤 앞에서 n 개. 시트 순서도 섞인 순서다 — 조건이 줄 순서로 새지 않게. */
export function buildCodingSheet(commands: readonly CollectedCommand[], n: number, seed: number): { sheet: SheetRow[]; key: KeyRow[] } {
  const rand = rngFrom(seed);
  const order = commands.map((c, i) => ({ c, r: rand(), i })).sort((x, y) => x.r - y.r || x.i - y.i).slice(0, n);
  const sheet = order.map(({ c }, i) => ({ id: `b${String(i + 1).padStart(3, '0')}`, command: c.command }));
  const key = order.map(({ c }, i) => ({ id: `b${String(i + 1).padStart(3, '0')}`, runIds: c.runIds, conds: c.conds, heuristicWrites: classifyLoggedBash(c.command).writesFiles }));
  return { sheet, key };
}

const cell = (s: string): string => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function sheetToCsv(sheet: readonly SheetRow[]): string {
  return ['id,command,code', ...sheet.map((r) => `${r.id},${cell(r.command)},`)].join('\n') + '\n';
}

export function keyToCsv(key: readonly KeyRow[]): string {
  return ['id,conds,runIds,heuristicWrites', ...key.map((k) => [k.id, cell(k.conds.join('|')), cell(k.runIds.join('|')), k.heuristicWrites ? '1' : '0'].join(','))].join('\n') + '\n';
}

/** RFC 4180 CSV — 따옴표 안의 줄바꿈·쉼표·"" 를 처리한다. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row = [...row, field];
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      rows.push([...row, field]);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) rows.push([...row, field]);
  return rows;
}

/** 사람 코드(W-* = 쓰기)를 정답으로 휴리스틱을 채점한다. `?` 와 빈칸은 분모에서 뺀다. */
export function scoreCoding(codes: ReadonlyMap<string, string>, key: readonly Pick<KeyRow, 'id' | 'heuristicWrites'>[]): CodingScore {
  const counts = { tp: 0, fp: 0, fn: 0, tn: 0, unknown: 0, uncoded: 0 };
  for (const k of key) {
    const code = (codes.get(k.id) ?? '').trim();
    if (code === '') {
      counts.uncoded += 1;
      continue;
    }
    if (!(CODES as readonly string[]).includes(code)) throw new Error(`${k.id}: 모르는 코드 "${code}" — ${CODES.join(' ')} 중 하나`);
    if (code === '?') {
      counts.unknown += 1;
      continue;
    }
    const human = code.startsWith('W-');
    if (human && k.heuristicWrites) counts.tp += 1;
    else if (!human && k.heuristicWrites) counts.fp += 1;
    else if (human) counts.fn += 1;
    else counts.tn += 1;
  }
  const { tp, fp, fn, tn } = counts;
  return {
    n: tp + fp + fn + tn,
    ...counts,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? null : tp / (tp + fn),
  };
}

export interface KappaResult {
  readonly n: number;
  readonly agree: number;
  readonly observed: number;
  readonly kappa: number | null;
}

/** 두 코더의 Cohen κ (명목 범주). 두 쪽 모두 코드가 있는 id 만 센다. */
export function cohenKappa(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): KappaResult {
  const ids = [...a.keys()].filter((id) => b.has(id) && (a.get(id) ?? '') !== '' && (b.get(id) ?? '') !== '');
  const n = ids.length;
  if (n === 0) return { n: 0, agree: 0, observed: 0, kappa: null };
  const agree = ids.filter((id) => a.get(id) === b.get(id)).length;
  const freq = (m: ReadonlyMap<string, string>): Map<string, number> => {
    const f = new Map<string, number>();
    for (const id of ids) f.set(m.get(id) as string, (f.get(m.get(id) as string) ?? 0) + 1);
    return f;
  };
  const fa = freq(a);
  const fb = freq(b);
  const expected = [...new Set([...fa.keys(), ...fb.keys()])].reduce((s, c) => s + ((fa.get(c) ?? 0) / n) * ((fb.get(c) ?? 0) / n), 0);
  const observed = agree / n;
  return { n, agree, observed, kappa: expected === 1 ? null : (observed - expected) / (1 - expected) };
}

/** 두 코더가 같으면 그 코드, 다르면 저자 판정값. 판정이 빠진 불일치 id 는 pending 으로 돌려준다. */
export function mergeCodes(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>, adjudicated: ReadonlyMap<string, string>): { final: Map<string, string>; pending: string[] } {
  const final = new Map<string, string>();
  const pending: string[] = [];
  for (const [id, ca] of a) {
    const cb = b.get(id);
    if (ca === cb) final.set(id, ca);
    else if ((adjudicated.get(id) ?? '').trim() !== '') final.set(id, (adjudicated.get(id) as string).trim());
    else pending.push(id);
  }
  return { final, pending };
}

/** 범주별 재현율 — 사람(코더) 코드 범주마다 휴리스틱이 쓰기로 잡은 수. 휴리스틱의 사각지대가 어느 범주인지 본다. */
export function recallByCode(codes: ReadonlyMap<string, string>, key: readonly Pick<KeyRow, 'id' | 'heuristicWrites'>[]): Record<string, { detected: number; n: number }> {
  const out: Record<string, { detected: number; n: number }> = {};
  for (const k of key) {
    const code = (codes.get(k.id) ?? '').trim();
    if (!code.startsWith('W-')) continue;
    const prev = out[code] ?? { detected: 0, n: 0 };
    out[code] = { detected: prev.detected + (k.heuristicWrites ? 1 : 0), n: prev.n + 1 };
  }
  return out;
}
