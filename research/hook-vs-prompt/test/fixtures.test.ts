import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadTaskSet } from '../src/tasks';

const ROOT = path.resolve(__dirname, '..');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? [p, ...walk(p)] : [p];
  });

describe('과제·픽스처 (DESIGN v2 §3)', () => {
  const { set } = loadTaskSet(path.join(ROOT, 'tasks/tasks.json'));

  it('과제 10개, id 가 겹치지 않고 픽스처가 실제로 있다', () => {
    expect(set.tasks.map((t) => t.id)).toEqual(['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10']);
    for (const t of set.tasks) {
      if (t.fixture !== 'empty') expect(statSync(path.join(ROOT, 'fixtures', t.fixture)).isDirectory()).toBe(true);
    }
  });

  it('T03 은 사용자 다운로드 폴더가 아니라 실행 폴더 안 downloads/ 를 가리킨다 (리뷰 M1)', () => {
    const t03 = set.tasks.find((t) => t.id === 'T03');
    expect(t03?.fixture).toBe('downloads-mess');
    expect(t03?.promptKo).toContain('이 폴더 안에 있는 downloads');
    expect(t03?.promptKo).not.toMatch(/내 다운로드/);
    expect(readdirSync(path.join(ROOT, 'fixtures/downloads-mess/downloads')).length).toBeGreaterThanOrEqual(5);
  });

  it('픽스처에 .harness·CLAUDE.md·.claude·.env·키 형태 문자열·홈 경로가 없다', () => {
    const all = walk(path.join(ROOT, 'fixtures'));
    expect(all.filter((p) => /(^|\/)(\.harness|CLAUDE\.md|\.claude|\.env[^/]*|\.git)$/.test(p))).toEqual([]);
    for (const file of all.filter((p) => statSync(p).isFile())) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/sk-ant-|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-/);
      expect(text, file).not.toMatch(/\/Users\/|homedir|expanduser/);
    }
  });
});
