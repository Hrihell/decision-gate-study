// 원고 그림 — 조건별 비율 막대 + Wilson 95% 구간. 의존성 없는 SVG 한 장.
// 흑백 인쇄를 전제로 회색 농도로 조건을 나누고, 막대 위에 k/n 을 글자로 남긴다.

interface RateLike {
  readonly k: number;
  readonly n: number;
  readonly rate: number;
  readonly wilson: { readonly lo: number; readonly hi: number };
}

export interface FigureMetric {
  readonly key: string;
  readonly label: string;
}

const CONDS = [
  { id: 'A', label: 'A', fill: '#ffffff' },
  { id: 'B', label: 'B', fill: '#bdbdbd' },
  { id: 'C', label: 'C', fill: '#636363' },
  { id: 'Cp', label: 'C′', fill: '#252525' },
] as const;

const LAYOUT = { height: 260, top: 24, bottom: 56, left: 40, right: 12, barWidth: 22, groupGap: 40 } as const;

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderRateFigure(descriptive: Readonly<Record<string, Readonly<Record<string, RateLike>>>>, metrics: readonly FigureMetric[]): string {
  const { height, top, bottom, left, barWidth, groupGap } = LAYOUT;
  const plotH = height - top - bottom;
  const y = (v: number): number => top + plotH * (1 - v);
  const groupW = barWidth * CONDS.length;
  const width = left + 16 + metrics.length * (groupW + groupGap) - groupGap + 16 + LAYOUT.right;
  const parts: string[] = [];

  for (const tick of [0, 0.25, 0.5, 0.75, 1]) {
    parts.push(`<line x1="${left}" x2="${width - LAYOUT.right}" y1="${y(tick)}" y2="${y(tick)}" stroke="#e0e0e0"/>`);
    parts.push(`<text x="${left - 4}" y="${y(tick) + 3}" text-anchor="end" font-size="9">${Math.round(tick * 100)}%</text>`);
  }

  metrics.forEach((m, gi) => {
    const byCond = descriptive[m.key];
    if (byCond === undefined) throw new Error(`분석 결과에 지표 ${m.key} 가 없다`);
    const gx = left + 16 + gi * (groupW + groupGap);
    CONDS.forEach((c, ci) => {
      const r = byCond[c.id] ?? { k: 0, n: 0, rate: 0, wilson: { lo: 0, hi: 0 } };
      const x = gx + ci * barWidth;
      const cx = x + barWidth / 2;
      parts.push(`<rect class="bar" x="${x + 2}" y="${y(r.rate)}" width="${barWidth - 4}" height="${y(0) - y(r.rate)}" fill="${c.fill}" stroke="#000" stroke-width="0.8"/>`);
      parts.push(`<line class="ci" x1="${cx}" x2="${cx}" y1="${y(r.wilson.hi)}" y2="${y(r.wilson.lo)}" stroke="#000" stroke-width="1"/>`);
      parts.push(`<text x="${cx}" y="${y(r.wilson.hi) - 3}" text-anchor="middle" font-size="7">${r.k}/${r.n}</text>`);
      parts.push(`<text x="${cx}" y="${y(0) + 11}" text-anchor="middle" font-size="9">${esc(c.label)}</text>`);
    });
    parts.push(`<text x="${gx + groupW / 2}" y="${y(0) + 26}" text-anchor="middle" font-size="10">${esc(m.label)}</text>`);
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif">\n<rect width="${width}" height="${height}" fill="#ffffff"/>\n${parts.join('\n')}\n</svg>\n`;
}
