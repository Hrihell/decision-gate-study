# 파일럿 관문 (DESIGN v2 §6.5)

> live 실행 분석

| # | 항목 | 판정 | 근거 |
|---|---|---|---|
| 1 | 무장: init hooks_applied === true (전 에피소드) | ✅ | 12/12 |
| 2 | init.tools ⊆ 공통 허용 목록 BASE_TOOLS (Agent·Skill·Web*·MCP·계획 모드·SendMessage 등 없음) | ✅ | init 24건 확인 |
| 3 | optionsHash 차이 = 허용 차이 키 (조건 쌍) | ✅ | 조건 A,B,C,Cp |
| 4 | 관찰 hook pre_tool 수 = 스트림 tool_use 수 | ✅ | 불일치 0건 |
| 5 | C: Write 가 plan_missing 으로 거부되고 Bash 쓰기형이 정책 G 줄에 닿음 | ✅ | plan_missing=true, G=true |
| 6 | B 의 append 가 실제로 들어갔는지 (별도 1회 확인 질의) | 수동 | RUNBOOK §3-6 |
| 7 | AskUserQuestion 자유 입력 답이 받아들여지는지 | ✅ | 정책 응답 Q,Q,Q,Q,Q,Q,Q,Q,Q,Q,Q — 다음 assistant 가 답을 읽었는지는 사람이 확인 |
| 8 | maxTurns 가 턴별인지 세션 전체인지 | 수동 | num_turns 와 error_max_turns 발생 시점 대조 |
| 9 | 실행 폴더 안에 CLI 가 만드는 파일(.claude 등) | ✅ | .claude 생성 9건 — snapshot 이 플래그만 남기고 V_disk 에서 제외 |
| 10 | 에피소드당 비용·시간 → §6.4 재계산 (상한 = p95 × 3, 리뷰 S8) | ✅ | 비용 p95 0.2867 USD → 권장 maxBudgetUsd 0.8601; 벽시계 최대 210542 ms |
| 11 | sandbox 설정 고정 + T06 네트워크(npx) 성공 여부 (리뷰 N2-2) | 수동 | T06 의 BASH 결과·sandbox 위반 메시지 확인 |
| 12 | 1턴 오류 뒤 2턴 진행 여부 (리뷰 M7-3) | 수동 | turn2_skipped 0건 |
| 13 | 실행 전 인증 확인 (리뷰 N2-1) — authcheck 결과 true | 수동 | RUNBOOK §2 |
| 14 | C 의 hook systemMessage 가 모델 문맥에 들어가는지 (리뷰 N2-3) | 수동 | 다음 assistant 입력에 한국어 알림이 보이는지 |
| 15 | subtype 별 is_error 값 (리뷰 M5) | 수동 | 종료 사유: ok |
| 16 | duration_ms 가 턴별인지 누적인지, permission_denials 에 hook deny 포함 여부 (M3·S6) | 수동 | 두 턴 result 대조 |
| 17 | 잔존 프로세스 0 (리뷰 M7) | ✅ | 잔존 0건 |
