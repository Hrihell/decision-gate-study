// 기록 전 가리기 (리뷰 M2). 실행 폴더·홈·사용자 이름·이메일·키 형태 문자열을 자리표시자로 바꾼다.
// 이것은 **둘째 층**이다 — 첫째 층은 애초에 남기지 않는 것(log.ts 의 축약 형식, env 키만, init 은 hooks_applied 만).

export interface RedactContext {
  readonly runDir: string;
  readonly home: string;
  readonly user: string;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** 흔한 키 형태. 정확한 탐지기가 아니다 — 공개 전 secretlint 를 따로 돌린다 (RUNBOOK). */
const SECRET_SHAPES =
  /\b(?:sk-ant-[\w-]{8,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})/g;

const replaceAll = (text: string, needle: string, token: string): string =>
  needle.length < 2 ? text : text.split(needle).join(token);

/** 실행 폴더의 `/var/…` 별칭도 가린다 (macOS). */
const aliasesOf = (dir: string): string[] =>
  dir.startsWith('/private/') ? [dir, dir.slice('/private'.length)] : [dir];

export function redactText(text: string, ctx: RedactContext): string {
  let out = text;
  for (const d of aliasesOf(ctx.runDir)) out = replaceAll(out, d, '<RUN_DIR>');
  out = replaceAll(out, ctx.home, '<HOME>');
  out = out.replace(EMAIL, '<EMAIL>').replace(SECRET_SHAPES, '<SECRET>');
  out = out.replace(/\/Users\/[^/\s'"]+/g, '/Users/<USER>');
  if (ctx.user.length >= 3) out = out.replace(new RegExp(`\\b${ctx.user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), '<USER>');
  return out;
}
