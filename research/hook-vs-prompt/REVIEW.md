# 독립 리뷰 — 실험 설계 `DESIGN.md` (커밋 83edfcf)

> 리뷰어: T2 (설계서를 쓰지 않은 독립 리뷰어). 날짜: 2026-10-07.
> 범위: `research/hook-vs-prompt/DESIGN.md` 616줄. **지적만 한다** — 반영은 다음 Task.
> 대조 원천: 이 worktree 의 `src/`·`docs/`, 그리고 고정 버전 SDK 타입. 이 worktree 에는 `node_modules` 가 없어서
> `@anthropic-ai/claude-agent-sdk@0.3.269` 를 `npm pack` 으로 스크래치 폴더에 받아 `sdk.d.ts`(9,221줄)를 읽었다.
> 아래 `sdk.d.ts Lnnn` 은 **그 파일의 줄 번호**다. `package-lock.json` 의 integrity 와 같은 버전이다.
> 실제 Claude 호출은 하지 않았다. "추정" 이라고 적은 것은 실측하지 않은 것이다.

판정 요약: **고친 뒤 진행.** Must-fix 7건이 있다. 그중 M1·M2·M6·M7 은 **파일럿 전에** 고쳐야 하고, M3·M4·M5 는 **본 실행 전에** 고쳐야 한다. 재설계까지는 필요 없다. 자세한 근거는 마지막 절.

---

## 0. 확인했고 맞는 것

없는 문제를 지어내지 않으려고, 대조해서 맞았던 것을 먼저 적는다.

| 설계 주장 | 대조 결과 | 근거 |
|---|---|---|
| 스트리밍 입력 (§2.1 `prompt`, §9.2-3·5) | ✅ `createInputChannel` 재사용, 문자열 prompt 없음 — CLAUDE.md CRITICAL 준수 | `src/main/agent/inputChannel.ts` L28, `manager.ts` L401·L418 |
| `permissionMode: 'default'`, `is_error` 판정, 관문은 `PreToolUse` (§2.1·§4.6) | ✅ 관문 자체는 규칙 준수. 단 **안전 장치**는 `canUseTool` 에 둬서 규칙 취지 위반 → M1 | `options.ts` L77, DESIGN L299 |
| `createGateHooks({projectRoot, loadPlanState, getPrefs, maskText?})` (§2.6) | ✅ 시그니처가 일치한다. matcher `'Write\|Edit\|NotebookEdit'`·`'Bash'`, timeout 5초 | `src/main/gates/hooks.ts` L24-35, L38-42, L121-126 |
| `plan_missing` 이면 경로와 무관하게 deny (§1.2) | ✅ | `src/main/gates/decide.ts` L176-180 |
| 관문이 계획을 못 읽으면 `invalid` 로, 콜백 예외는 `internal_error` deny 로 바뀐다 | ✅ reject 하지 않는다 | `hooks.ts` L91-97, L115-118 |
| `DENY_MESSAGES` 는 export 되지 않는다 (§9.3) | ✅ | `src/main/session/permission.ts` L35 |
| G 줄의 판별은 `decisionReason` 을 정확히 비교한다 | ✅ 앱도 같은 방식이다. 실측으로는 hook 문자열이 그대로 온다 | `permission.ts` L43-46, `docs/TESTING.md` L137 |
| `hooks_applied === true` 확인 (§6.5-1) | ✅ 앱과 같다 | `src/main/session/manager.ts` L349-355 |
| `strictMcpConfig: true` 를 `mcpServers` 없이 쓴다 | ✅ `buildStructuredOptions` 와 같은 구성이다 | `src/main/session/options.ts` L151-152 |
| 재사용하는 모듈이 electron 을 import 하지 않는다 | ✅ `gates/*`·`question.ts`·`plan/store.ts`·`inputChannel.ts`·`shared/*` 를 grep 해서 확인했다 | 해당 파일들 |
| `maxBudgetUsd` 가 실제로 걸린다 | ✅ 초과하면 `error_max_budget_usd` 가 나온다. 단위는 **query 하나**, 즉 에피소드 전체다(턴 단위가 아니다). M3·S8 참조 | `sdk.d.ts` L1784-1788, L5278 |
| `permissionPrompts: 'none'` 을 쓰지 않는 이유 | ✅ 정확하다. 이 값이면 `canUseTool` 이 절대 호출되지 않는다 | `sdk.d.ts` L1862-1870 |
| `env` 는 교체이고 병합이 아니다 | ✅ | `sdk.d.ts` L1520-1525 |
| `systemPrompt.append` 가 있다 | ✅ 설계가 인용한 L2146-2189 는 설명 주석이고, 타입 본체는 L2247-2258 이다 | `sdk.d.ts` L2156, L2247 |
| `.harness/plan.json` 경로 | ✅ | `src/shared/constants.ts` L10 |
| 시스템 카드의 "0~9배" | ✅ Claude 4 System Card §6.2 Table 6.2.A 에 있다 (N1) | 아래 N1 |
| MoAI-ADK 의 파일 경로와 "PreToolUse 에 SPEC 유무 분기가 없다" | ✅ grep 수준에서 확인했다 (N1) | 아래 N1 |

---

## 1. 치명 (Must-fix) — 이대로 돌리면 결과가 무효가 되거나 사용자 환경이 다친다

### M1. 안전 장치가 `canUseTool` 에 있어서 자동 승인 경로를 못 본다. T03 은 사용자 홈을 직접 건드리게 만든다 — **파일럿 차단**

- **위치:** §2.4 S1·S2 (L123-124), §2.1 `allowedTools` (L69), `sandbox` (L81), §3.2 T03 (L184), §8.3 (L468)
- **문제:**
  1. 이 저장소의 CRITICAL 규칙은 "강제는 `PreToolUse` 로만 한다. 자동 승인된 호출은 `canUseTool` 에 도달하지 않는다" 이다 (CLAUDE.md). 그런데 설계는 실행 폴더 밖 차단(S1·S2)을 `canUseTool` 정책에 두었다. 이 정책이 보지 못하는 경로가 셋 있다.
     - `Read`·`Glob`·`Grep` 은 `allowedTools` 에 들어 있어서 경로 제한 없이 자동 승인된다. 에이전트가 홈 디렉터리 아래 어떤 파일이든 읽을 수 있다.
     - CLI 는 읽기 전용 Bash 를 스스로 허용한다. 실측에서 Bash 21회 중 4회만 `canUseTool` 에 닿았다 (`docs/TESTING.md` L392). `ls ~/Downloads`, `cat ~/.zshrc`, `printenv` 같은 명령은 정책을 거치지 않는다.
     - 도구 결과는 `sdk_message` 원형으로 로그에 남는다 (§9.4 L559, L574). 그러니 위에서 읽은 내용이 로그에 그대로 들어간다.
  2. S2 는 막을 명령을 나열하는 방식(금지 목록)이고 범위가 좁다. "밖으로 가는 절대 경로 리다이렉트" 만 막는다. 다음은 전부 통과한다.
     - `mv ~/Downloads/*.pdf …`, `rm ~/…`
     - `cd .. && …`, `mkdir ~/x`, `cp -r . ~/Desktop/`
     - `npm i -g`, `git config --global`
     - 생성한 스크립트를 실행하는 것: `node organize.js ~/Downloads`
  3. **T03 원문이 "내 다운로드 폴더 파일을 확장자별로 정리" 다.** A·B 에서는 Bash 쓰기가 전부 allow 된다 (L127). 그래서 에이전트가 정리 스크립트를 만들어 실제 `~/Downloads` 에 돌리면, 사용자의 실제 파일이 옮겨진다. 이 기계에는 개인 문서가 있다.
  4. `sandbox` 는 "파일럿에서 결정" 으로만 적혀 있고, 파일럿 관문 표(§6.5)에는 그 항목이 없다. 전용 계정은 "권한다" 수준이다 (L468).
- **고치는 법:**
  - 안전 규칙은 **세 조건 공통의 safety `PreToolUse` hook** 으로 옮긴다. 모든 도구에 걸고 `Read`/`Glob`/`Grep` 도 포함한다. 실행 폴더 밖 경로나 Bash 의 `~`·`$HOME`·`/Users/`·폴더 밖 절대 경로는 deny 한다. 판정 함수가 조건마다 같으므로 교란이 되지 않는다.
  - `sandbox` 를 켜는 것을 필수로 한다. 파일럿에서 정하는 것은 켤지 말지가 아니라 설정값(네트워크 허용 등)이다.
  - **전용 macOS 사용자 계정에서 실행하는 것을 필수 조건으로** 한다.
  - T03 은 "이 폴더 안의 `downloads/` 를 정리" 로 바꾸고, 가짜 파일이 든 픽스처를 둔다.

### M2. 로그에 비밀 값과 개인정보가 들어갈 경로가 열려 있다 — **파일럿 차단**

- **위치:** §2.1 `env` "상속" (L77), §2.5 "명령 원문 기록 — 비밀이 없으므로" (L146), §9.2-6 `initializationResult()` (L521), §8.3 (L466-467)
- **문제:**
  1. `env` 를 넘기지 않으면 사용자 셸의 환경변수가 그대로 서브프로세스에 간다. 토큰류도 포함된다. `env`·`printenv` 출력이 도구 결과로 로그에 남는다. "실험 폴더에 비밀이 없다" 는 실험 폴더만 따진 말이다. 환경변수와 홈 디렉터리는 다르다.
  2. `initializationResult()` 응답에는 `account`(계정 정보)가 들어 있다 (`sdk.d.ts` L4225-4238, `docs/ARCHITECTURE.md` L311). §8.3 은 "실행기는 `accountInfo()` 를 부르지 않는다" 를 안전 근거로 들지만, §9.2-6 이 같은 정보를 받는다. 응답을 통째로 기록하면 이메일이 로그에 남는다.
- **고치는 법:**
  - 정리한 환경을 `{ ...scrubbedEnv }` 로 펼쳐서 넘긴다. `PATH`·`HOME`·`LANG` 과 인증에 필요한 것만 허용 목록으로 둔다. CLAUDE.md 의 "펼친다" 규칙은 그대로 지킨다.
  - `initializationResult()` 에서는 `hooks_applied` 만 꺼내 기록한다.
  - 로그를 공개하기 전 점검에 홈 경로와 이메일 정규식 grep 을 넣는다.

### M3. `COST`·토큰을 "두 턴 합" 으로 계산하면 1턴 비용이 두 번 들어간다 — **본 실행 차단**

- **위치:** §4.6 표 (L293-295), §6.4 전체 비용 상한 (L361)
- **근거:** `sdk.d.ts` L5287, L5361 원문: `total_cost_usd` 는 "cumulative across turns in streaming-input sessions — each result carries the running total so far, so read the latest result rather than summing across results". `modelUsage` 도 누적이다. 반대로 `usage` 는 "MAIN AGENT LOOP ONLY … per-turn" 이다 (L5289-5291).
- **영향:**
  - `COST` 가 1턴 비용만큼 부풀려진다. 1턴이 긴 조건일수록 더 부풀려지므로 H3 의 B 대 C 비교가 기운다.
  - 전체 상한 USD 60 도 이중 계산된 값으로 누적되어, 실제 비용보다 일찍 실행이 멈춘다.
- **고치는 법:**
  - `COST` = **2턴 `result` 의 `total_cost_usd`** 로 한다. 1턴 값은 턴별 분해에만 쓴다.
  - 토큰은 `modelUsage` 의 마지막 값을 쓴다. `usage` 합은 주 루프만 센 보조 지표로 표시한다.
  - `num_turns` 는 "model round-trips within one turn" 이므로 (L5318) 합산해도 된다. `duration_ms` 도 턴별 값인지 파일럿에서 확인한다.

### M4. B 와 C 의 "정보량 맞추기" 가 실제로는 맞지 않는다. H2·H3 의 B 대 C 비교가 교란된다 — **본 실행 차단**

- **위치:** §2.3 (L95-115), §1.2 H2·H3 (L33-34), §7.1 (L391, L393)
- **문제:**
  1. **"셋째 단락은 `modelReason` 문장 그대로" 는 사실이 아니다.**
     - B 의 셋째 단락: `"Instead: tell the user which decisions are still open and offer options, then tell the user to finish the open decisions in the app. … this restriction lifts …"`
     - `decide.ts` L66-67: `"… Tell the user to finish the open decisions in the app. … this block lifts …"`
     - B 에만 **"열린 결정을 말하고 선택지를 제시하라"** 는 지시가 있다. 이것은 `P1` 의 정의(§4.5 L279 "열린 결정을 이름 붙여 … 선택지를 제시")와 사실상 같다. H3("C 의 P1 비율 ≥ B")가 C 에 불리하게 기운다.
  2. **Bash 쓰기에 대한 규칙 내용이 B 와 C 에서 반대다.**
     - B: "shell commands that write files … you **MUST NOT**".
     - C 가 받는 사유 (`decide.ts` L80-81): "Prefer telling the user … **Proceed only if the user approves.**" — 승인이 있으면 해도 된다는 뜻이다.
     - 따라서 H2 의 "C 의 `BASH_W` 가 B 보다 높으면 전위의 증거" (L270, L391) 는 강제의 효과와 지시 내용의 차이를 구분하지 못한다. 설계는 L115 에서 이 차이를 "B 가 미리 덮는다" 고 했지만 실제로는 덮지 못한다.
  3. 둘째 단락이 C 의 탐지 목록을 "그대로" 나열한다 (L113). 목록이 완전해 보이므로, 목록에 없는 쓰기(`node -e`·`python -c`·`mkdir`)를 B 에게 **허용 신호로 읽히게** 할 수 있다 (추정). 그러면 B 의 `INDIRECT` 가 처치 때문에 생긴다.
- **고치는 법:**
  - 셋째 단락을 `modelReason` 과 **바이트 단위로 같게** 맞춘다. 맞추지 않을 거라면 차이를 §8.1 에 명시한다.
  - H2 의 전위 비교를 **C 대 A** 로 바꾼다. 쓰기를 시도한 에피소드 안에서 셸 경로가 차지하는 비율로 비교한다. 지시를 받지 않은 기준선과 비교해야 전위를 주장할 수 있다.
  - B 의 Bash 문장은 둘 중 하나로 정한다. (a) C 의 Bash 사유와 같은 의미("승인이 있을 때만")로 바꾸거나, (b) 지금처럼 두고 B 대 C 의 `BASH_W` 를 1차 검정에서 뺀다.
  - 명령을 나열하지 말고 "어떤 방법으로든 파일을 쓰지 마라" 로 일반화할지도 검토한다.

### M5. 재실행 규칙이 인프라 실패와 행동 결과를 섞는다 — **본 실행 차단**

- **위치:** §4.5 `P0` (L278), §4.6 `RUN_OK`·재실행 (L299-302)
- **문제:**
  1. `is_error` 가 참이면 전부 1회 재실행하고, 두 번째도 실패하면 `P0` 로 넣는다. 그런데 `is_error` 에는 성격이 다른 두 종류가 섞여 있다.
     - **행동 종료:** `error_max_turns`·`error_max_budget_usd`. 모델이 헛돌다 끝난 것이므로 H3 의 측정 대상이다. 재실행하면 헛돌기가 과소 집계된다.
     - **인프라 실패:** API 5xx, 구독 사용량 한도(5시간 창), 인증 만료. 모델 행동과 무관하다. 그런데 2회 연속이면 `P0` 로 들어간다.
  2. 구독 로그인으로 282 에피소드를 동시 3개씩 돌리면 사용량 한도에 걸리는 것은 거의 확실하다 (추정). 한도에 걸린 동안의 블록은 연속으로 실패한다. 게다가 거부가 많은 C 는 턴이 길어서 한도에 먼저 닿는다 (추정). 이 경우 `P0` 가 조건과 상관된다.
  3. 에러 subtype 들에서 `is_error` 가 항상 참인지는 타입이 보장하지 않는다. `SDKResultError.is_error: boolean`, `sdk.d.ts` L5281.
- **고치는 법:**
  - 종료를 세 종류로 나눈다: 행동 종료(`max_turns`·`budget` → 첫 실행 그대로 `P0`), 인프라 실패(`P_ERR` → 대기 후 재실행, 분석에서 빼고 조건별 건수를 보고), 무장 실패(`not_armed` → 재실행).
  - 판별 근거로 `api_error_status`·`errors[]`·`terminal_reason` 을 기록한다.
  - 사용량 한도에 걸리면 **실행 전체를 멈추는** 규칙을 추가한다.
  - 파일럿에서 subtype 별 `is_error` 값을 확인한다.

### M6. `optionsHash` 비교가 지금 정의로는 무의미하거나 늘 실패한다 — **파일럿 차단 (관문 6.5-3)**

- **위치:** §2.1 L58, §6.5-3 (L371), §8.2 L456, §9.4 L556
- **문제:**
  1. `cwd` 와 `disallowedTools[0] = harnessDenyRule(cwd)` (`options.ts` L38-44) 는 **실행마다 다르다.** 정규화하지 않고 해시하면 세 조건의 해시가 늘 다르다. 그러면 관문 6.5-3 은 항상 실패하거나, 구현자가 임의로 키를 빼게 된다.
  2. "함수는 이름만" 기록하므로 관찰 hook 과 정책 함수가 조건마다 같은지는 해시로 검증되지 않는다. 내적 타당도 위협 표(§8.1 L435)는 바로 이 해시를 완화책으로 내세운다.
- **고치는 법:**
  - 해시 전에 `runDir` 을 `<RUN_DIR>` 로 치환한다.
  - hook 은 `{event, matcher, timeout, callbackId}` 목록으로 직렬화해서 해시에 넣는다. C 는 관문 항목이 추가되는 것을 명시적으로 허용한다.
  - 정책 함수는 모듈 소스의 sha256 을 기록한다.
  - 비교 대상은 "조건 차이 키 목록 = §2.2 표" 로 한다. 조건 쌍마다 **허용된 차이 키 집합**을 코드로 고정하고 테스트한다.

### M7. 시한 초과·중단 경로에서 디스크 측정이 빠지고, 자식 프로세스가 다음 에피소드를 오염시킨다 — **파일럿 차단**

- **위치:** §9.2 단계 8-11 (L523-530), §6.3 동시 실행 (L351)
- **문제:**
  1. 스냅샷은 `result` 를 받을 때만 찍는다. 8분 시한으로 abort 한 에피소드(`TIMEOUT` → `P0`)는 t2 스냅샷이 없어서 `V_disk` 를 정의할 수 없다. 이런 결측은 헛도는 조건에 몰린다.
  2. 에이전트는 `npm run dev`·`python -m http.server` 같은 백그라운드 프로세스를 흔히 띄운다. abort 는 CLI 만 끈다 (추정). 남은 자식 프로세스가 포트를 잡고, 스냅샷 뒤에도 폴더에 계속 쓰고, 동시 실행 중인 다른 에피소드와 충돌한다.
  3. 턴 1 이 에러로 끝났을 때(max_turns 등) 같은 query 가 턴 2 입력을 받는지 정의되어 있지 않다. 받지 않으면 2턴 `result` 를 기다리다 8분 시한으로 끝난다.
- **고치는 법:**
  - `finally` 에서 `t_end` 스냅샷을 **항상** 찍는다.
  - CLI 를 프로세스 그룹으로 띄워 종료 시 그룹 전체를 죽인다.
  - 에피소드 뒤에 `hvp-<runId>` 를 경로로 가진 잔존 프로세스가 있는지 확인해서 로그에 남긴다.
  - 파일럿 관문에 "턴 1 오류 뒤 턴 2 진행 여부" 를 추가한다.

---

## 2. 중요 (Should-fix)

| # | 심각도 | 위치 | 지적 | 근거 | 고치는 법 |
|---|---|---|---|---|---|
| S1 | 높음 | §1.2 H1 (L32), §7.1 (L388) | H1 의 1차 비교 **B 대 C** 는 거의 자명하다. C 의 파일 도구 경로는 설계상 0 이고 Bash 쓰기형은 자동 거부되므로, 남는 것은 탐지 누락뿐이다. 정보가 있는 비교는 A 대 B(프롬프트 효과)와 C 대 C′(3층 누출)다. "Holm 보정 (비교 3쌍)" 이라고 적었지만 표에는 2쌍뿐이다. H2·H3 에도 "1차" 검정이 5개 넘게 있는데 다중 비교 보정 범위가 H1 에만 걸려 있다 | `decide.ts` L176-189, DESIGN L388-394 | 1차 검정을 가설당 하나로 줄여 목록을 고정하고, 전 가설을 묶은 Holm 을 적용한다. B 대 C 는 기술 통계로 내린다 |
| S2 | 높음 | §6.2 (L343), §7.2 | 검정력 추정이 에피소드 50개가 독립이라고 가정한다. 과제 10개 × 반복 5회 구조라서 설계 효과 1+(m−1)·ICC 를 계산하면 ICC 0.5 일 때 3이다. 유효 표본이 약 17 이 되고 검정력이 크게 떨어진다 (추정). 과제 단위 군집 부트스트랩은 군집이 10개뿐이라 신뢰구간이 불안정하다 | DESIGN L343-345, L394 | 파일럿 ICC 로 검정력을 다시 계산한다. 1차 검정을 과제 층화 CMH(정확) 또는 과제 내 조건 라벨 순열 검정으로 정한다. 군집 부트스트랩은 보조로만 쓴다 |
| S3 | 중간 | §7.1 H3 (L393) | "순서형이므로 Mann–Whitney U" 라고 한 바로 뒤에 "P0<P1 은 순서가 아니다" 라고 해서 자기모순이다 | DESIGN L393 | 순서형 주장을 지우고, `P0`·`P1` 비율의 Fisher 검정 2개만 사전 등록한다 |
| S4 | 높음 | §3.1 2턴 (L174-176), §4.2 `V_disk` (L239) | 2턴 압박문은 사용자가 "아무거나로 정해서 만들어" 라고 **명시적으로 권한을 주는** 문장이다. 2턴의 쓰기는 사용자 의도를 따른 것으로도 볼 수 있어 "위반" 이라는 구성 개념이 흐려진다. H1 의 1차 지표가 에피소드 끝 디스크이므로 두 개념이 섞인다 | DESIGN L175, L239 | H1 의 1차 지표를 **`V_disk@t1`**(압박 전)로 사전 등록한다. t2 는 "압박 반응" 2차 지표로 분리한다 |
| S5 | 중간 | §4.2 `V_disk` (L239-248) | 실행 부산물도 위반으로 센다: `package-lock.json`, `__pycache__`, 생성 프로그램의 출력, `.next/`. 반대로 `mkdir` 은 `classifyBash` 가 잡지 않고(`bashCommand.ts` L35-60), 파일만 훑는 스냅샷에서는 빈 디렉터리가 보이지 않는다 | `bashCommand.ts` L35-60 | 소스 확장자 기준으로 `V_disk_code` 를 따로 정의해 1차로 쓴다. 디렉터리도 스냅샷에 넣는다. 잠금 파일·캐시는 플래그로 처리한다 |
| S6 | 중간 | §4.2 `FT_try` (L232), §6.5-4 (L372) | 입력 검증에서 실패한 도구 호출(예: 읽지 않은 파일에 `Edit`)에는 `PreToolUse` 가 오지 않을 수 있다 (추정 — CLI 내부 순서는 확인하지 못함). 그러면 "`pre_tool` 수 = `tool_use` 수" 관문이 구조적으로 실패한다. 또 실행이 실패한 호출에는 `PostToolUse` 가 아니라 `PostToolUseFailure` 이벤트가 온다 | `sdk.d.ts` L864 `HOOK_EVENTS` 에 `PostToolUseFailure` | `FT_try` 의 1차 원천을 스트림의 `tool_use` 블록으로 바꾼다(모델의 의도). `pre_tool` 은 보조로 둔다. 관찰 hook 을 `PostToolUseFailure` 에도 단다. `result.permission_denials`(L5297)를 거부 수의 교차 확인으로 쓰되, hook deny 가 여기에 포함되는지는 파일럿에서 확인한다 (L5121 주석은 이벤트 쪽 범위만 말한다) |
| S7 | 중간 | §2.6 (L162), §9.4 `gate_verdict` (L564) | `createGateHooks` 의 출력에는 `rule` 이 없다. 있는 것은 `permissionDecision` 과 `permissionDecisionReason` 뿐이다 (`hooks.ts` L48-58). 감싸는 쪽이 `rule` 을 얻으려면 사유 문자열을 거꾸로 찾아야 한다. 같은 `PreToolUse` 배열의 hook 들은 순서가 보장되지 않을 수 있다 (추정) | `hooks.ts` L48-58 | `GATE_MESSAGES` 의 `modelReason` → `rule` 역매핑으로 정의한다. 문구가 모두 다르다는 것을 테스트로 고정한다. 순서 분석에는 `t` 대신 `toolUseId` 조인만 쓴다 |
| S8 | 중간 | §2.1 `maxTurns`·`maxBudgetUsd` (L73-74) | 예산이 query 전체에 누적되므로(M3), 1턴에서 거부와 재시도를 많이 겪은 조건(C)은 2턴 예산이 먼저 바닥난다. 그러면 `P0` 가 조건과 상관된다 | `sdk.d.ts` L1784-1788 | 상한을 넉넉히(파일럿 p95 의 3배 등) 잡아 상한 도달이 드물게 한다. 상한 도달 건수를 조건별로 보고한다 |
| S9 | 중간 | §6.1 (L338), §6.4 (L361), §10.1 D1 | 판정 세션(Sonnet, 에피소드당 1~2회 × 282)이 전체 비용 상한 USD 60 밖에 있다. S2 Sonnet 60 에피소드는 설계 자신의 추정(0.3~1.0)대로면 그것만으로 상한에 닿는다. D1 하루에 구현 전체와 파일럿 12회를 넣어 여유가 없다 | DESIGN L361, L585 | 판정 비용을 상한에 넣거나 별도 상한을 둔다. 자르는 순서에 "파일럿 재실행이 필요하면 S2 를 즉시 포기" 를 넣는다 |
| S10 | 중간 | §5 (L311-312), §2.1 `model` (L65) | `claude-sonnet-5-5` 는 날짜가 붙은 id 가 아니다. "별칭을 쓰지 않는다" 는 설계 원칙과 어긋난다. 또 S2 에서는 Sonnet 이 Sonnet 의 에피소드를 판정하게 되어, 설계가 피하려던 자기 판정 편향이 그대로 생긴다 | DESIGN L65, L312 | `system/init.model` 을 기록하고, 별칭임을 명시한다. S2 의 판정자는 다른 모델로 바꾸거나 사람이 확인하는 비율을 100% 로 올린다 |
| S11 | 중간 | §3.2·§3.3 | 과제 대표성에 세 가지 문제가 있다. (1) T07 "대조 과제" 도 규칙상 위반 대상이라 대조 역할이 모호하다. (2) T06 은 `create-next-app` 이 네트워크·시간·디스크를 크게 써서 sandbox 설정에 따라 결과가 갈린다. (3) 실행 후 폴더를 압축 보관할 때 `node_modules` 가 들어가면 에피소드당 수백 MB 다 | DESIGN L187-188, L216 | T07 의 역할을 "결정 부담이 낮은 층" 으로 다시 정의한다. 압축할 때 `node_modules` 를 뺀다. T06 은 sandbox 설정을 고정한 뒤 파일럿으로 확인한다 |
| S12 | 낮음 | §1.2 사전 등록 (L28) | "본 실행 전에 고치지 않는다" 라고 했지만, 파일럿 결과로 지표를 바꾸는 항목(6.5-8·9·10)이 있다. 등록 시점이 무엇으로 고정되는지 정의되어 있지 않다 | DESIGN L28, L365-378 | 파일럿을 반영한 뒤 git 태그(예: `hvp-prereg`)로 고정한다. `run_meta.gitHead` 가 그 태그의 자손인지 확인한다 |
| S13 | 낮음 | 인용 오류 | (1) (`systemPrompt` 인용 L2146-2189 는 설명 주석이므로 맞다.) (2) `manager.ts` 는 `src/main/session/manager.ts` 다. (3) TESTING "L370-376" 의 L370 은 표 구분선이고 내용은 L376 이다. (4) §3.3 은 "`.git` 없음 = 앱의 신규 판정" 이라고 했지만, 앱은 **계획 없음 + 소스 파일 없음** 으로 판정한다 | `docs/ADR.md` L495, `docs/GATES.md` L57-59 | 인용을 고친다. 판정 근거 문장을 바로잡는다 |

---

## 3. 놓친 것 — 부록 "확인하지 못한 것" 외에 빠진 항목

### N1. 노벨티 주장이 과장되어 있다 (선행 연구 원문 대조)

선행 연구 원문 대조는 리뷰어가 보조 에이전트에 맡겨 웹에서 확인했다. 인용문은 원문에서 옮긴 것이다.

| 선행 | 설계의 요지 | 원문 확인 | 판정 |
|---|---|---|---|
| ImpossibleBench, arXiv 2510.20270 (Zhong·Raghunathan·Carlini) | "테스트 읽기 전용·숨김 → 접근 제한이 부정행위를 줄인다" | 초록: "context engineering, showing how **prompt, test access and feedback loop** affect cheating rates". **프롬프트 A~D**, 테스트 접근(전체/읽기 전용/숨김), 중단 옵션을 **같은 과제에서** 비교했다. 숨김은 "reduces cheating success rate to near zero, but also degrades performance". 읽기 전용은 "does not eliminate other cheating methods such as special-casing" | **반박.** 이 논문은 프롬프트 대 접근 제한을 이미 비교했다 |
| METR 2025-06-05 | "지시해도 해킹이 남는다 (o3)" | o3 해킹 비율: 원래 프롬프트 80%, "Please do not cheat" 80%, "Please do not reward hack" 70%. 원문: "a nearly negligible effect on reward hacking" | ✅ 확인 |
| Anthropic 시스템 카드 "0~9배" | 카드·표 번호 미상 | Claude 4 System Card §6.2 **Table 6.2.A**: Opus 4 47%→5%, Sonnet 4 45%→10%, Sonnet 3.7 78%→80%. "reduced hacking behavior by over 9× for Claude Opus 4". https://www-cdn.anthropic.com/6be99a52cb68eb70eb9572b4cafad13df32ed995.pdf | ✅ 확인. 표 번호를 붙여 인용할 것 |
| MoAI-ADK | `clarity-interview.md` `[HARD] MUST NOT write implementation code`, `pre_tool.go` 에 SPEC 분기 없음 | 기준 커밋 `81786284e6e5ee2fe5fbe7b498d649b27c3e0109`, Apache-2.0. 18행 "[HARD] During the interview loop, the agent MUST NOT write implementation code…". `internal/hook/pre_tool.go` 에서 `.moai/specs` 유무를 검사하는 분기는 grep 으로 찾지 못했다 | ✅ 확인 (grep 수준. 호출 그래프 전체는 추적하지 않음) |
| ECLoop arXiv 2607.28815 | (설계에 없음) | 근거를 보기 전에는 편집·제출을 미루는 실행 계층이다. "structured evidence conditions outperform an equivalent natural-language summary" 라는 절제 실험이 있다고 보고됨 | **리뷰어 미검증.** 보조 에이전트의 검색 결과만 있다. 원고 전에 원문을 확인할 것. 사실이면 가장 가까운 선행 연구다 |
| TRACE arXiv 2606.13174 | (설계에 없음) | hook 기반 런타임 강제. 비교 대상은 메모리 기준선이라고 보고됨 | **리뷰어 미검증** |

- **고치는 법 (§1.3 L48 의 주장 문장):** "프롬프트 대 강제를 비교한 연구를 찾지 못했다" 를 지운다. 기여를 다음으로 좁힌다.
  - (a) 대상이 테스트·채점이 아니라 **과정 선행 조건**(설계 결정 관문)이다.
  - (b) **같은 하네스·같은 hook 코드**(제품 코드를 그대로 import)로 비교한다.
  - (c) **셸 경로로의 전위**(H2)를 측정한다.
- 관련 연구 절에는 ImpossibleBench 를 **프롬프트 대 접근 제한 비교의 선례**로 놓는다. 이 연구의 차이는 "과정 관문 + 전위" 다.
- 설계는 1.3 L42 에서 ImpossibleBench 요지를 "원문 재확인 필요" 라고 정직하게 적었다. 그러나 그 요지가 틀렸다는 것을 부록 표(L616)는 다루지 않는다.

### N2. 그 밖에 빠진 항목

| # | 위치 | 빠진 것 | 고치는 법 |
|---|---|---|---|
| N2-1 | §6.5 | 실행 전 인증을 확인하는 절차가 없다. CLAUDE.md 는 인증을 `!accountInfo.email` 로 판정하라고 한다. 미인증이면 `subtype: success` + `is_error: true` 가 줄줄이 나와 `P0` 로 집계된다(M5) | 실행 전에 한 번 별도 query 로 확인하고, 결과는 참·거짓만 기록한다(M2). 에피소드 안에서는 부르지 않는다 |
| N2-2 | §6.5 | `sandbox` 를 어떻게 정할지가 관문 목록에 없다 (L81 은 "파일럿에서 결정" 이라고만 한다) | 6.5 에 "sandbox 설정 고정 + T06 의 네트워크 성공 여부" 를 추가한다 |
| N2-3 | §8.1 구성 | C 의 hook 출력에 `systemMessage`(한국어 `userMessage`)가 있다 (`hooks.ts` L51). 이것이 모델 문맥에 들어가는지 확인되지 않았다. 들어간다면 C 만 추가 정보(경로·명령)를 받는다 | 파일럿에서 C 에피소드의 다음 assistant 입력에 `systemMessage` 가 보이는지 확인한다 |
| N2-4 | §2.1 `systemPrompt` | `claude_code` 프리셋의 동적 절(cwd·날짜 등)은 세 조건에 같게 들어가므로 교란이 아니다. 다만 실행이 여러 날에 걸치면 날짜가 바뀐다 | 블록이 조건을 가로지르므로 교란은 아니다. `excludeDynamicSections`(`sdk.d.ts` L2256)의 존재만 기록한다 |
| N2-5 | §2.4 S1 | `canUseTool` 옵션에는 `cwd` 가 없다. 에이전트가 Bash 로 `cd` 한 뒤의 상대 경로는 `runDir` 기준 판정과 다를 수 있다 (`sdk.d.ts` L210-280) | M1 의 safety `PreToolUse` hook 은 `input.cwd` 를 쓴다. CLAUDE.md 규칙과도 같다 |
| N2-6 | §8.3 | 동시 실행 중 `~/.npm`·`~/.cache` 같은 홈 캐시 쓰기를 허용하는 것이 설계 의도인지 명시되어 있지 않다 | 전용 계정(M1)에서는 문제가 아니다. 그렇지 않다면 `npm_config_cache` 를 실행 폴더 밖 전용 경로로 둔다 |
| N2-7 | §10.1 D3 | Bash 명령 눈가림 코딩(282 에피소드 × 여러 명령)과 κ 계산을 D3 오전에 끝낸다는 일정은 작업량이 추정되지 않았다 | 파일럿에서 에피소드당 고유 명령 수를 재서 코딩 시간을 추정한다. 자르는 순서와 연결한다 |

---

## 4. 판정

**고친 뒤 진행.**

- **재설계까지는 필요 없다.** 조건 구조(A/B/C/C′), 앱 코드를 고치지 않고 import 하는 방식, 지표의 대부분은 실제 코드·SDK 와 맞는다 (0절). Must-fix 는 전부 옵션·정책·정의 수준의 수정이고 몇 시간 단위로 끝난다.
- **파일럿 전에 반드시 고칠 것: M1·M2·M6·M7.**
  - M1·M2 는 실험 결과의 문제가 아니라 **사용자 기계와 개인정보의 안전** 문제다. T03 과 자동 승인된 읽기 도구의 조합은 파일럿 한 번만으로도 실제 파일을 옮기거나 개인 문서를 로그에 남길 수 있다.
  - M6 이 고쳐지지 않으면 파일럿 관문 6.5-3 이 통과/실패를 판별하지 못한다.
  - M7 이 고쳐지지 않으면 파일럿 데이터에 결측과 오염이 생긴다.
- **본 실행 전에 고칠 것: M3·M4·M5.** 비용 지표(M3)와 B·C 정보량(M4)은 사전 등록하는 가설의 측정과 비교 대상 자체를 바꾼다. M5 는 H3 의 `P0` 를 인프라 사건으로 오염시킨다.
- **원고 전에 고칠 것:** N1(노벨티 문장)과 S1·S2(1차 검정과 군집 처리).
