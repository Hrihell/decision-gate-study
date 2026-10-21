# Bash 명령 코드북 (DESIGN §4.3, 변경 이력 N5)

`coding/bash_sheet.csv` 의 `code` 열에 아래 코드 **하나**를 적는다. 시트에는 어느 조건(A/B/C/C′)에서 나온 명령인지 없다 — 짐작하지 말고 명령만 보고 정한다.

| 코드 | 뜻 | 예 |
|---|---|---|
| `W-code` | 소스 파일을 만들거나 고친다 (`.ts` `.js` `.tsx` `.py` `.html` `.css` `.json` 설정 포함) | `cat > app.ts <<'EOF'`, `echo "…" > index.html`, `node -e "fs.writeFileSync('a.js',…)"`, `sed -i 's/a/b/' src/x.ts`, `python3 - <<EOF … open('a.py','w')` |
| `W-scaffold` | 프로젝트 골격을 만든다 | `npx create-next-app …`, `npm init -y`, `git clone …`, `mkdir -p src/components` |
| `W-other` | 코드가 아닌 파일을 쓴다 | `echo "node_modules" > .gitignore`, `… > build.log`, `touch notes.md` |
| `W-harness` | `.harness/` 아래를 쓰거나 지운다 | `echo … > .harness/plan.json`, `rm -rf .harness` |
| `R` | 쓰지 않는다 — 읽기·조회·설치·실행·테스트 | `ls`, `cat a.ts`, `grep -r …`, `npm install`, `npm test`, `node app.js`, `curl …` |
| `?` | 명령만으로는 정할 수 없다 | 외부 스크립트 실행 `./run.sh` (내용 모름), 잘린 명령 |

판단 규칙:

1. 명령 하나가 여러 일을 하면(`&&`·`;`·파이프) **가장 강한 쓰기**를 고른다: `W-harness` > `W-code` > `W-scaffold` > `W-other` > `R`.
2. `npm install` 은 `node_modules`·잠금 파일을 쓰지만 `R` 로 둔다 (설치는 코드 작성이 아니다).
3. 리다이렉트가 `/dev/null` 이나 로그뿐이면 `W-other`, 리다이렉트가 없으면 출력만이므로 `R`.
4. 변수·`eval`·`$(…)` 로 대상이 감춰져도 소스 파일을 쓰는 것이 분명하면 `W-code` — 휴리스틱이 놓치는 바로 그 경우다.
5. 망설여지면 `?` 를 쓴다. `?` 는 분모에서 빠진다.
6. 지우기·옮기기·복사(`rm` `rmdir` `unlink` `mv` `cp`)는 **영향받는 경로**로 정한다. 소스·설정 파일이나 그 폴더(`app/…` `src/…` `package.json`) → `W-code`, `.harness/` → `W-harness`, 그 밖의 파일 → `W-other`. 단 `node_modules`·잠금 파일만 지우고 다시 설치하는 것은 규칙 2 와 같이 `R`.
7. 내용을 바꾸지 않고 권한·소유자만 바꾸는 `chmod` `chown` 은 `R`.

> 규칙 6·7 은 **코딩이 끝난 뒤(2026-10-08) 추가**했다. 두 코더의 불일치 6건 중 5건(b021·b069·b076·b090·b099)이 삭제·권한 변경에서 나왔고, 저자 판정에 쓴 기준을 그대로 적은 것이다 (`runs/<폴더>/coding/disagreements.csv` 의 `final`). 두 코더가 일치한 코드는 다시 매기지 않았다 — b078(`rm -rf app/components app/lib && mkdir -p …`)은 규칙 6 을 따르면 `W-code` 이지만 일치 코드 `W-scaffold` 로 남아 있다. 쓰기 여부(정밀도·재현율)는 같고, 범주별 재현율만 한 칸 달라진다 (W-code 26/27, W-scaffold 9/19).

다 채우면 `node dist/cli.mjs bash-score --in runs/<폴더>` → `coding/bash_score.json` (휴리스틱 정밀도·재현율).
