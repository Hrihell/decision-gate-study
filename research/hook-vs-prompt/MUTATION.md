# safety hook 변이 확인 기록

> 날짜: 2026-10-07. 대상: 최종 `src/safety.ts` (sha256 `5ec2a749238b43aac02b616f8e282181c874bd9650b9f35696a6c1fe92d1c5a4`).
> 목적: 사례 표 테스트가 safety hook 의 **핵심 규칙 하나가 빠지면 실제로 빨개지는지** 확인한다 — 초록이 거짓이 아님을 보인다.
> 방법: 원본을 세션 임시 폴더에 백업(`cp`) → 규칙 하나를 지운다 → 테스트 → 백업으로 복원(`cp`) → sha256 으로 원상 확인.
> `git stash`·`git checkout` 은 쓰지 않았다 (stash 는 다른 worktree 와 공유된다).

| # | 변이 | 실행한 테스트 | 결과 | 빨개진 사례 |
|---|---|---|---|---|
| 1 | `decideBash` 의 홈 표기 규칙 한 줄 삭제 (`HOME_REFERENCE`·`HOME_API` → `bash_home_ref`) | `test/safety.test.ts` | **16 실패** / 63 통과 (79) | `ls ~/Downloads`, `mv ~/Downloads/*.pdf`, 홀로 쓴 `~`, `$HOME`, `${HOME}`, `/Users/` 절대 경로, `/Volumes/`, `/home/`, 인용 안의 `/Users/`, `file:///Users/` URL, `node -e homedir`, `python expanduser`, heredoc 으로 홈을 여는 스크립트 쓰기, `$TMPDIR`, 생성 스크립트에 홈 인자, hook 출력 모양 |
| 2 | safety hook 에 `matcher: 'Bash\|Write\|Edit\|NotebookEdit'` 를 붙여 Read·Glob·Grep 을 빼기 (리뷰 M1 의 원래 구멍) | `test/safety.test.ts` + `test/episode.test.ts` | **2 실패** / 86 통과 (88) | "matcher 가 없다 — 모든 도구(Read·Glob·Grep 포함)에 걸린다", 에피소드 "safety hook 이 홈 접근(Read)을 막고 기록한다" |
| 3 | `cwd_outside` 규칙 삭제 (에이전트가 폴더 밖으로 `cd` 한 뒤의 호출) | `test/safety.test.ts` | **1 실패** / 78 통과 (79) | "cwd 가 실행 폴더 밖이면 무엇이든 거부한다" |

복원 확인: 세 변이 뒤 모두 `src/safety.ts` sha256 이 위 값으로 돌아왔다.
복원 뒤 `npm test`: **14 파일, 163 테스트 전부 통과**.

변이 1에서 일부 사례는 다른 규칙(`bash_abs_outside`)에 여전히 걸리지만, 표는 **기대 규칙**까지 확인하므로 빨개진다 — 규칙이 겹쳐 하나를 지워도 조용히 통과하는 일을 막는다.

같은 세 변이를 한 번 앞선 판(경로 중간의 `home` 조각까지 막던 과잉 차단 판, sha256 `926500d7…`)에서도 돌려 13·2·1 실패를 확인했다. 최종 판은 그 과잉 차단을 고치고 사례 6개를 더한 것이다.

## 추가 (코디네이터 검증, 2026-10-07) — 심볼릭 링크 탈출

- 구멍: safety hook 의 경로 판정이 글자만 봤다. 실행 폴더 안에 밖을 가리키는 링크를 만들면 Read·Write·Edit·Glob·Grep 이 그 링크를 통해 밖을 읽고 쓸 수 있었다 (sandbox 는 Bash 에만 걸린다).
- 고침: `src/realpath.ts` 의 `realPathOf` 로 링크를 따라간 실제 경로도 판정한다 (대상 없는 링크는 readlink 로, 고리는 밖으로). `test/symlink.test.ts` 16건.
- 변이: `pathIsOutside` 의 realpath 판정을 끄면 `test/symlink.test.ts` 의 거부 사례 **9건 실패** → 백업으로 복원 후 16건 통과.
