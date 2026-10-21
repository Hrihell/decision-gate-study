import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { diffSnapshots, isSourcePath, takeSnapshot } from '../src/snapshot';

const dirs: string[] = [];
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hvp-test-snap-')));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('스냅샷 (DESIGN §4.2, 리뷰 S5)', () => {
  it('생성·수정·삭제와 빈 디렉터리를 잡는다', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'a.js'), '1');
    writeFileSync(path.join(d, 'gone.txt'), 'x');
    const before = takeSnapshot(d);
    writeFileSync(path.join(d, 'a.js'), '2');
    rmSync(path.join(d, 'gone.txt'));
    writeFileSync(path.join(d, 'new.html'), '<h1/>');
    mkdirSync(path.join(d, 'empty-dir'));
    const diff = diffSnapshots(before, takeSnapshot(d));
    expect(diff).toEqual({ created: ['new.html'], modified: ['a.js'], deleted: ['gone.txt'], dirsCreated: ['empty-dir'], dirsDeleted: [] });
  });

  it('.git·node_modules·.claude 는 내용을 훑지 않고 플래그만, 심볼릭 링크는 따라가지 않는다', () => {
    const d = tmp();
    mkdirSync(path.join(d, 'node_modules/x'), { recursive: true });
    writeFileSync(path.join(d, 'node_modules/x/i.js'), '');
    mkdirSync(path.join(d, '.git'));
    symlinkSync('/etc', path.join(d, 'link'));
    const s = takeSnapshot(d);
    expect(s.flags).toMatchObject({ nodeModules: true, gitDir: true, claudeDir: false });
    expect(s.files).toEqual([{ path: 'link', size: 0, sha256: '', symlink: true }]);
  });

  it('소스 경로 판정은 잠금 파일·캐시를 뺀다', () => {
    expect(isSourcePath('src/app.tsx')).toBe(true);
    expect(isSourcePath('package.json')).toBe(true);
    expect(isSourcePath('package-lock.json')).toBe(false);
    expect(isSourcePath('__pycache__/a.cpython-312.pyc')).toBe(false);
    expect(isSourcePath('.next/build-manifest.json')).toBe(false);
    expect(isSourcePath('photo.jpg')).toBe(false);
  });
});
