// 공개 전 유출 검사 (리뷰 M2 "로그를 공개하기 전 점검"). 결과에는 **값을 싣지 않는다** — 파일·줄·종류만.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export interface LeakFinding {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
}

export interface LeakContext {
  readonly home: string;
  readonly user: string;
  /** 이름이 비밀처럼 보이는 환경변수의 값 (12자 이상) */
  readonly secretValues: readonly { readonly name: string; readonly value: string }[];
}

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|SESSION/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const KEY_SHAPES = /sk-ant-[\w-]{8,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16}/;
const USERS_PATH = /\/Users\/(?!<USER>)[^/\s"'<]+/;
// texMacros.ts 가 만드는 숫자 매크로 이름 `\csname R@cost.totalUsd\endcsname` — 모양이 이메일과 같다
const TEX_MACRO_NAME = /\\csname R@[^\\\s]*\\endcsname/g;

export function leakContextFromEnv(env: Readonly<Record<string, string | undefined>>, home: string, user: string): LeakContext {
  const secretValues = Object.entries(env)
    .filter(([k, v]) => SECRET_NAME.test(k) && typeof v === 'string' && v.length >= 12)
    .map(([name, value]) => ({ name, value: value as string }));
  return { home, user, secretValues };
}

export function scanText(text: string, ctx: LeakContext): { line: number; kind: string }[] {
  const out: { line: number; kind: string }[] = [];
  text.split('\n').forEach((l, i) => {
    const at = i + 1;
    if (ctx.home.length > 1 && l.includes(ctx.home)) out.push({ line: at, kind: 'home_path' });
    if (USERS_PATH.test(l)) out.push({ line: at, kind: 'users_path' });
    if (EMAIL.test(l.replace(TEX_MACRO_NAME, ''))) out.push({ line: at, kind: 'email' });
    if (KEY_SHAPES.test(l)) out.push({ line: at, kind: 'key_shape' });
    for (const s of ctx.secretValues) if (l.includes(s.value)) out.push({ line: at, kind: `env_value:${s.name}` });
  });
  return out;
}

export function scanDir(dir: string, ctx: LeakContext): LeakFinding[] {
  const files = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = path.join(d, n);
      return statSync(p).isDirectory() ? files(p) : [p];
    });
  return files(dir).flatMap((f) => scanText(readFileSync(f, 'utf8'), ctx).map((x) => ({ file: path.relative(dir, f), ...x })));
}
