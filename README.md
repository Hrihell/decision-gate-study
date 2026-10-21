# 코딩 에이전트의 설계 결정 관문 — 연구 자료

KSC 2026 투고 논문 「코딩 에이전트의 설계 결정 관문: 프롬프트 지시와 실행 계층 강제의 비교」의 실험 하네스, 분석 코드, 코드북, 코딩 시트, 에피소드 자료입니다. 심사 기간에는 익명화된 사본으로 제공됩니다.

## 구성

| 경로 | 내용 |
|---|---|
| `research/hook-vs-prompt/src/` | 실험 하네스(조건 정의 `conditions.ts`, ask 처리 정책 `policy.ts`, 관문 연결 `hooks.ts`, 안전 hook, 스냅샷, 로그 기록) |
| `src/main/gates/`, `src/main/plan/`, `src/main/session/`, `src/shared/` | 하네스가 수정 없이 가져다 쓰는 제품 관문 코드(하네스 실행에 필요한 파일만) |
| `research/hook-vs-prompt/analysis/` | 추출·분석·재코딩·강건성·LaTeX 매크로 생성 |
| `research/hook-vs-prompt/tasks/`, `fixtures/` | 과제 10개와 기존 프로젝트 과제의 시작 파일 |
| `research/hook-vs-prompt/codebook.md`, `prog_codebook.md` | 셸 명령·진행 텍스트 코드북 |
| `research/hook-vs-prompt/DESIGN.md` | 설계 문서(최종) |
| `research/hook-vs-prompt/DESIGN_at_hvp-prereg.md` | 1차 검정을 실행 전에 고정한 시점(git 태그 `hvp-prereg`)의 설계 문서 원문 — §1.2 가설, §7.1 1차 분석 |
| `research/hook-vs-prompt/results/` | 블록별 결과: `ksc`(주 실험 120회), `d`·`e`·`f`·`h`(탐색 각 30회), `sonnet15`(탐색 60회), `n8`(탐색 결과 묶음), `pilot`·`pilot2`, `dryrun`(mock — 수치 의미 없음) |
| `research/hook-vs-prompt/results/*/coding/` | LLM 코더 2인의 코딩 시트, 불일치 목록, 확정 키, 일치도 |
| `research/hook-vs-prompt/runs/` | 원 로그(`logs/*.jsonl`), 에피소드 작업 폴더 스냅샷(`archives/*.tar.gz`), 실행 상태 |
| `research/paper/figures/make_figures.py` | 논문 그림 1 생성 스크립트 |

## 논문 수치와 자료의 대응

- 논문의 모든 수치는 `\R{경로}` 매크로로 들어갑니다. 원고의 results.tex 는 다음 파일들을 이어 붙인 것입니다.
  - `results/ksc/results.tex`
  - `results/ksc/coding/coding.tex`, `recode.tex`, `robust.tex`
  - `results/n8/n8.tex`
- 각 `.tex` 는 같은 폴더의 `.json` 에서 `analysis/texMacros.ts` 로 생성됩니다.
- 표 1·2 와 본문 수치 → `results/ksc/analysis.json`(1차 검정 `primary.*`), `coding/recode.json`(눈가림 재코딩), `coding/robust.json`(군집 bootstrap·설계효과·MDE), `n8/n8.json`(탐색 D·E·F·H·Sonnet).
- 그림 1 → `python3 research/paper/figures/make_figures.py research/hook-vs-prompt/results/ksc` (Matplotlib 3.10.8, 나눔고딕).

## 다시 실행하기

```bash
cd research/hook-vs-prompt
npm ci
npm test            # 타입 검사 + 단위 테스트
npm run build       # dist/cli.mjs
npm run dryrun      # mock 백엔드로 파이프라인 확인(실제 API 호출 없음)
```

- 실제 Claude 호출(`--backend live`)에는 `--live` 플래그와 `HVP_LIVE_CONFIRM` 환경변수가 모두 필요합니다(`src/backends/backend.ts`).
- 설정: 주 실험 `claude-haiku-4-5-20251001`, Claude Code CLI 2.1.269, Agent SDK 0.3.269, 순열 검정 10,000회(시드 20261008).
- 실행 절차는 `RUNBOOK.md` 에 있습니다.

## 코딩

- 셸 명령·진행 텍스트는 조건을 가린 시트로, LLM 코더 2인이 맥락을 공유하지 않고 독립 코딩했습니다(Claude Opus 5.5 `claude-opus-5-5`, Claude Sonnet 5.5 `claude-sonnet-5-5`).
- 불일치는 코드북 글자대로 낸 판정안을 저자가 검토해 확정했습니다.
- 탐색 블록 코딩 두 건에서는 Opus 코더가 코딩 도중 같은 세션의 조언 도구(advisor, `claude-fable-5-1`)를 호출했습니다.
  - D·Sonnet 진행 텍스트 시트에서 2회, F 의 셸 명령 시트에서 1회입니다.
  - 주 실험(`ksc`) 코딩에서는 호출하지 않았습니다.

## 익명화와 자료 처리

- 저자 이름·소속·연락처와 저자 컴퓨터의 경로를 지웠습니다. 설계 문서 두 곳의 로컬 경로는 `<HOME>/…` 로 바꿨습니다.
- `archives/*.tar.gz` 는 tar 헤더의 소유자 이름·번호만 비우고 다시 묶었습니다.
  - 안의 파일 이름·권한·시각·내용(sha256)은 원본과 같음을 확인했습니다.
  - 그래서 `MANIFEST.json` 의 아카이브 해시는 새 파일과 다릅니다.
- 원 로그는 기록 단계에서 이메일·토큰 같은 문자열을 가렸습니다(`src/log.ts` `redactDeep`).
  - 이 가리기가 JSON 이스케이프를 깨뜨린 줄은 고쳤고, `REPAIR.json` 에 기록했습니다.
  - 가리기 전 원본(`logs-raw/`)은 포함하지 않았습니다.
- `results/ksc/MANIFEST.json` 은 `episodes.csv` 에 열 2개(`BYPASS_turn`, `BYPASS_ok_t1`)를 추가하기 전에 만든 것입니다. 기존 열의 값은 같습니다.
- 에이전트가 만든 앱 안의 예시 사용자 이름 등은 모델 출력 그대로 두었습니다.
- `runs/INVALID-h-*` 는 정책 결함으로 버린 H 의 첫 실행입니다. 논문에는 쓰지 않았고, 투명성을 위해 남겼습니다.
- 탐색 조건 F(E + "막히면 멈추고 보고하라" 지시)는 실행 전에 "원고 밖이 기본"으로 정한 블록이라 논문 본문에는 없습니다(`DESIGN.md` N10).
