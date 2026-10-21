// analysis.json → LaTeX 매크로. 원고는 \R{descriptive.V_disk_code_t1.A.k} 처럼 경로로 숫자를 꺼낸다.
// 손으로 옮기지 않으므로 재분석하면 원고 숫자가 따라 바뀐다. 없는 경로는 ??경로?? 로 보여 빠뜨림이 드러난다.

const ACCESSOR = '\\newcommand{\\R}[1]{\\ifcsname R@#1\\endcsname\\csname R@#1\\endcsname\\else\\textbf{??\\detokenize{#1}??}\\fi}';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const def = (name: string, value: string): string => `\\expandafter\\def\\csname R@${name}\\endcsname{${value}}`;

function walk(value: unknown, path: string, out: string[]): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 비율이 정확히 0·1 일 때도 백분율이 있어야 한다 — .pct 는 모든 수에 붙인다
    out.push(def(path, Number.isInteger(value) ? String(value) : value.toFixed(3)));
    out.push(def(`${path}.pct`, String(Math.round(value * 100))));
    out.push(def(`${path}.pfmt`, value < 0.001 ? '$<$0.001' : value.toFixed(3)));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}.${isRecord(item) && typeof item.id === 'string' ? item.id : String(i)}`, out));
    return;
  }
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) walk(v, path === '' ? k : `${path}.${k}`, out);
  }
}

export function toTexMacros(report: unknown): string {
  const out: string[] = [];
  walk(report, '', out);
  return ['% analysis.json 에서 자동 생성 — 손으로 고치지 않는다 (cli.mjs tex-macros)', ACCESSOR, ...out].join('\n') + '\n';
}
