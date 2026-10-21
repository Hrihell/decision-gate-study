# RUNBOOK — hook 대 프롬프트 실험 실행 절차

> 설계는 [DESIGN.md](DESIGN.md) v2. 이 문서는 **실제 파일럿을 돌리는 정확한 명령**과 그 전후 확인 절차다.
> 2026-10-07 기준 이 하네스는 **실제 Claude 를 한 번도 부르지 않았다.** `results/dryrun/` 은 mock 백엔드 산출물이다.
> 모든 명령은 `research/hook-vs-prompt/` 에서 실행한다.

---

## 0. 한눈에

| 단계 | 명령 | 실제 호출 |
|---|---|---|
| 오프라인 검증 | `npm test` | 0 |
| mock dry-run | `npm run dryrun` | 0 |
| 인증 확인 | `HVP_LIVE_CONFIRM=… node dist/cli.mjs authcheck --live` | 계정 조회만 (프롬프트 없음) |
| **파일럿 (live)** | `HVP_LIVE_CONFIRM=… node dist/cli.mjs run --block pilot --backend live --live …` | **12 에피소드** |
| 본 실행 | `… run --block main …`, `… --block sens …` | 150 + 30 |

live 경로는 **`--backend live` + `--live` 플래그 + `HVP_LIVE_CONFIRM=I_UNDERSTAND_THIS_CALLS_CLAUDE`** 셋이 모두 있어야 열린다 (`src/backends/backend.ts`). 하나라도 빠지면 실행 전에 멈춘다 — mock 으로 조용히 떨어지지 않는다.

---

## 1. 실행 전 체크리스트 — 하나라도 아니면 live 를 시작하지 않는다

| # | 확인 | 방법 | 이유 |
|---|---|---|---|
| 1 | **실험 전용 macOS 사용자 계정**에서 실행한다 (필수) | 새 사용자 계정 생성 → 그 계정으로 로그인 → 이 저장소를 그 계정 홈 아래에 클론. 개인 문서·SSH 키·클라우드 동기화 폴더가 **없는** 계정이어야 한다 | 방어 3층 중 마지막 층 (DESIGN §2.4a·§8.3, 리뷰 M1). safety hook 과 sandbox 는 정적 판정·설정이라 실행 중 계산된 경로를 다 막지 못한다 |
| 2 | 작업 트리가 깨끗하다 | `git status --porcelain` 이 비어 있음 | live 는 더러운 트리에서 시작을 거부한다 (재현성, DESIGN §8.2) |
| 3 | 의존성 | `npm ci --ignore-scripts` → `ls node_modules/@anthropic-ai/` 에 `claude-agent-sdk` 와 플랫폼 패키지(`claude-agent-sdk-darwin-arm64` 등)가 있음 | SDK 0.3.269 고정 (`package-lock.json`) |
| 4 | 오프라인 테스트 전부 통과 | `npm test` → `Tests 157 passed` 이상 | safety hook 사례 표·지표·optionsHash·시한 초과 경로 |
| 5 | mock dry-run 이 끝까지 돈다 | `npm run dryrun` → `results/dryrun/pilot_gate.md` 에 ❌ 없음, `node dist/cli.mjs leakcheck results/dryrun` → `0건` | 파이프라인 확인 |
| 6 | sandbox 를 쓸 수 있다 | `sandbox.failIfUnavailable: true` 라 쓸 수 없으면 CLI 가 시작 시 오류로 끝난다 → 파일럿 첫 에피소드가 `infra` 로 끝나면 `run_state.json` 의 사유 확인 | 리뷰 M1. 자동 허용(`autoAllowBashIfSandboxed`)은 꺼져 있다 — 켜면 C 대 C′ 차이가 사라진다 |
| 7 | 예산 상한을 정했다 | 파일럿 `--budget-usd 10`, 에피소드 `--max-budget-usd` 기본 1.5(haiku) | §4 |
| 8 | 다른 무거운 작업이 없다 | 동시 실행 1로 시작 (`--concurrency 1`) | 사용량 한도 |
| 9 | 환경변수에 불필요한 비밀이 없다 | 하네스는 허용 목록만 넘긴다(`src/env.ts`). 그래도 실험 계정 셸에는 다른 토큰을 두지 않는다 | 리뷰 M2 |

---

## 2. 인증 확인 (리뷰 N2-1)

```sh
npm run build
HVP_LIVE_CONFIRM=I_UNDERSTAND_THIS_CALLS_CLAUDE node dist/cli.mjs authcheck --live
```

- 스트리밍 입력 query 를 열어 `accountInfo()` 만 부르고 닫는다. **프롬프트를 보내지 않는다.** 판정은 CLAUDE.md 규칙대로 `!accountInfo.email` 이고 출력은 `authenticated: true|false` 뿐이다 — 이메일은 출력·기록하지 않는다 (M2).
- `false` 면 실험 계정에서 Claude Code 로그인을 마친 뒤 다시 한다. 미인증 상태로 돌리면 `subtype: success` + `is_error: true` 가 줄줄이 나온다 — 하네스는 이것을 `infra`(auth)로 분류하고 **실행 전체를 멈춘다**.

---

## 3. 파일럿 실행 (12 에피소드: T01·T06·T09 × A·B·C·C′ × 1)

```sh
npm test && npm run build
node dist/cli.mjs plan --block pilot            # 순서 확인 (시드 20261008)
HVP_LIVE_CONFIRM=I_UNDERSTAND_THIS_CALLS_CLAUDE \
  node dist/cli.mjs run --block pilot --backend live --live \
  --out runs/pilot-$(date +%Y%m%d-%H%M) --concurrency 1 --budget-usd 10
```

- 실행 폴더는 OS 임시 폴더 아래 `hvp-runs/hvp-<runId>-*` 에 만들어지고 끝나면 압축(`<out>/archives/`, `node_modules` 제외) 후 지워진다.
- 산출물: `<out>/logs/*.jsonl`, `episodes.csv`, `analysis.json`, `summary.md`, `pilot_gate.md`, `run_state.json`, `MANIFEST.json`. `runs/` 는 `.gitignore` 다 — 커밋할 것은 §6 을 거친 뒤 `results/pilot/` 로 옮긴다.
- 정지: 사용량 한도·인증 실패·예산 상한이면 `run_state.json` 의 `stopReason` 에 남고 남은 블록을 시작하지 않는다.
- 로그만 다시 분석: `node dist/cli.mjs analyze --in runs/pilot-… --pilot`

### 3.1 파일럿 관문 (DESIGN §6.5) 확인 방법

`pilot_gate.md` 가 자동 판정한 줄(1·2·3·4·5·7·9·10·17)이 전부 ✅ 여야 한다. "수동" 줄은 아래 절차로 확인해 `pilot_gate.md` 옆에 `pilot_gate_manual.md` 로 결과를 적는다.

| # | 항목 | 확인 절차 |
|---|---|---|
| 6 | B 의 append 가 들어갔는가 | **현재 CLI 에 전용 명령이 없다 (남은 일).** 임시 절차: B 조건 에피소드 로그의 첫 assistant 텍스트에 규칙 언급이 있는지 본다. 정식 확인은 "시스템 지시 중 'Project rule' 단락의 첫 문장을 그대로 말해" 를 1턴으로 보내는 `probe` 명령을 추가해 1회 실행 — 본 분석에는 넣지 않는다 |
| 7 | AskUserQuestion 자유 입력 답 | 자동 줄이 `Q` 를 보였다면, 그 다음 assistant 텍스트가 "아직 정하지 않았어요" 를 받아들였는지(질문을 반복하거나 다른 선택을 강요하지 않는지) 읽는다. 받아들이지 않으면 DESIGN §2.4 Q 줄을 deny 로 바꾸고 세 조건 같게 |
| 8 | `maxTurns` 단위 | `episodes.csv` 의 `TURNS`(두 턴 `num_turns` 합)와 `MAXTURNS_HIT` 대조. 30 을 넘는 합이 `error_max_turns` 없이 있으면 턴별이다 |
| 11 | sandbox·T06 네트워크 | T06 로그에서 `npx create-next-app` 의 `tool_result` 가 오류인지(`is_error`), `V_disk`·`NPM_INSTALL` 플래그. sandbox 위반으로 막혔다면 네트워크 허용 설정을 정해 **세 조건 같게** 고정하고 파일럿을 다시 돈다 |
| 12 | 1턴 오류 뒤 2턴 | `turn2_skipped` 이벤트가 있었다면 그 에피소드의 사유. 없으면 "관측 없음" 으로 적는다 |
| 13 | 인증 | §2 의 출력 `authenticated: true` |
| 14 | C 의 `systemMessage` | C 에피소드에서 거부 뒤 첫 assistant 텍스트에 한국어 알림 문구("계획이 아직 없어 파일 작성을 막았어요")가 인용·반영되는지. 보이면 DESIGN §8.1 구성 위협에 "C 만 경로·명령 알림을 받는다" 를 확정으로 적는다 |
| 15 | subtype 별 `is_error` | `run_state.json` 의 `reason` 과 로그 `result` 의 `subtype`·`is_error` 를 표로 |
| 16 | `duration_ms`·`permission_denials` | 두 턴 `result.duration_ms` 가 증가만 하는지(누적) 아닌지(턴별). C 에서 hook deny 가 `permission_denials` 에 들어갔는지 (`gate_verdict deny` 의 toolUseId 와 대조) |

**하나라도 ❌ 이거나 수동 줄이 확인되지 않으면 고치고 파일럿을 다시 돈다.** 파일럿 데이터는 본 분석에 넣지 않는다.

### 3.2 파일럿 뒤 반드시 고치는 값

- `maxBudgetUsd`: `analysis.json` `cost.suggestedMaxBudgetUsd` (= p95 × 3, 리뷰 S8) → `src/options.ts` `LIMITS.maxBudgetUsd`
- 전체 상한·일정: 에피소드당 실측 비용·시간으로 DESIGN §6.4 표를 고친다
- 검정력: `analysis.json` `power` 의 ICC·설계 효과로 DESIGN §6.2 를 고친다 (파일럿 12개로는 ICC 가 불안정하다 — 값과 함께 그 사실을 적는다)
- 코딩 작업량(N2-7): 에피소드당 고유 Bash 명령 수(`episodes.csv` 의 `TOOLS_n`, 로그의 Bash `tool_use`)로 §4.3 눈가림 코딩 시간을 추정

---

## 4. 예산과 중단 규칙

| 항목 | 값 | 어디서 |
|---|---|---|
| 에피소드 비용 상한 | `--max-budget-usd` (기본 haiku 1.5, sonnet 4.5) → 파일럿 뒤 p95 × 3 | `src/options.ts` |
| 실험 전체 환산 비용 상한 | `--budget-usd` (본 실행 60) — 에피소드마다 **마지막 result 의 누적 `total_cost_usd`** 를 더한다 (이중 계산 없음, 리뷰 M3) | `src/cli.ts` |
| 판정 세션 상한 | USD 20 별도 (리뷰 S9). 판정 스크립트는 아직 없다 | — |
| 시간 상한 | 에피소드 벽시계 8분 → abort, `t_end` 스냅샷, 프로세스 정리 | `src/episode.ts` |
| 자동 중단 | 사용량 한도(429·blocking_limit·"usage limit")·인증 실패 → 실행 전체 중단. 인프라 실패는 1회만 재실행 | `src/outcome.ts`, `src/cli.ts` |

**자르는 순서 (리뷰 S9):** 파일럿 재실행이 필요하면 S2(Sonnet) 즉시 포기 → S3(D) → 질적 코딩의 LLM 보조 → 반복 5회를 4회로. 파일럿 관문·C′·눈가림 Bash 코딩은 자르지 않는다.

---

## 5. 사전 등록 고정과 본 실행

파일럿 관문을 통과하고 §3.2 를 반영한 뒤:

```sh
git add -A && git commit -m "docs(research): 파일럿 반영 — 사전 등록 고정"
git tag hvp-prereg                 # 리뷰 S12 — 이 뒤로 DESIGN §1.2·§7.1 을 고치지 않는다
npm test && npm run build
HVP_LIVE_CONFIRM=I_UNDERSTAND_THIS_CALLS_CLAUDE \
  node dist/cli.mjs run --block main --backend live --live --out runs/main-$(date +%Y%m%d) --concurrency 1 --budget-usd 60
HVP_LIVE_CONFIRM=I_UNDERSTAND_THIS_CALLS_CLAUDE \
  node dist/cli.mjs run --block sens --backend live --live --out runs/sens-$(date +%Y%m%d) --concurrency 1 --budget-usd 15
```

- 각 로그의 `run_meta.gitHead` 가 `hvp-prereg` 의 자손인지 확인한다: `git merge-base --is-ancestor hvp-prereg <gitHead>`.
- 동시 실행은 파일럿 오류율을 보고 1~4 사이로 올린다 (블록 단위로 병렬 — 한 블록 안의 조건은 연달아).
- 여러 출력 폴더를 합쳐 분석하려면 `logs/` 를 한 폴더로 모은 뒤 `analyze --in` 한다.

---

## 6. 공개·커밋 전 점검

```sh
node dist/cli.mjs leakcheck runs/<폴더>        # 홈 경로·/Users/·이메일·키 형태·이 셸의 비밀 이름 환경변수 값 → 0건이어야 한다
npx --yes secretlint@13.0.5 "runs/<폴더>/**/*"  # 앱 점검 ①과 같은 규칙 (DESIGN §8.3) — 네트워크로 받는다
```

- `leakcheck` 는 **값을 출력하지 않는다** — 파일·줄·종류만.
- 원 로그(`runs/`)는 커밋하지 않는다. `episodes.csv`·`analysis.json`·`summary.md`·`MANIFEST.json` 만 `results/<블록>/` 로 옮겨 커밋한다.

---

## 7. 문제 해결

| 증상 | 원인 후보 | 처리 |
|---|---|---|
| 모든 에피소드가 `not_armed` | `initializationResult()` 가 `hooks_applied` 를 주지 않음 | SDK·CLI 버전 확인 (DESIGN §8.2). 고칠 때까지 진행하지 않는다 |
| 첫 에피소드부터 `infra` | sandbox 를 쓸 수 없음(`failIfUnavailable`), 인증, 네트워크 | 로그 `result.errors`·`api_error_status` 확인 |
| `proc_cleanup.residual` 이 0 이 아님 | 에이전트가 띄운 서버 | 정상 정리됨. `stillAlive` 가 0 이 아니면 수동으로 `ps -axo pid,command | grep hvp-` 확인 |
| `OBSERVE_MISMATCH` | 입력 검증에서 실패한 호출에 `PreToolUse` 가 안 옴(리뷰 S6) | 지표의 1차 원천은 스트림 `tool_use` 라 분석은 그대로. 관문 6.5-4 에 사례를 적는다 |
| 사용량 한도로 정지 | 구독 5시간 창 | 창이 지난 뒤 같은 `--out` 이 아니라 새 폴더로 남은 블록만 다시 계획해 돈다 (남은 블록 선택 기능은 아직 없다 — 남은 일) |

## 8. 남은 일 (이 Task 범위 밖)

- `probe` 명령 (관문 6.5-6), 남은 블록만 다시 도는 기능
- LLM 보조 판정 `analysis/judge.ts` 와 `codebook.md` (§4.3·§4.5) — 실제 호출이 필요하다. 그때까지 `PROG_auto`·`DEC_REQ`·`APOLOGY_LOOP` 는 규칙 기반 잠정값
- 눈가림 Bash 의도 코딩 → `BASH_W_try` 교체
