// 메인과 렌더러 양쪽에서 import 된다. Node 전역(process)도 DOM 전역(window)도 쓰지 않는다.

/** electron-builder.yml 의 appId 와 같아야 한다. */
export const APP_ID = 'com.vibecoach.app';

/** 사용자에게 보이는 앱 이름. */
export const APP_NAME = 'vibe-coach';

/** 계획 파일의 프로젝트 루트 기준 상대 경로. */
export const PLAN_RELATIVE_PATH = '.harness/plan.json';

/** 결정 관문 파일(생성된 선택지와 답)의 프로젝트 루트 기준 상대 경로. */
export const GATES_RELATIVE_PATH = '.harness/gates.json';

/** 점검 예외 처리 파일("일부러 그랬어요")의 프로젝트 루트 기준 상대 경로. 커밋한다 (AUDITS.md 4.7). */
export const AUDIT_SUPPRESSIONS_RELATIVE_PATH = '.harness/audit-suppressions.json';

/** 활동 기록 파일(작업마다 바뀐 파일과 요청)의 프로젝트 루트 기준 상대 경로. 커밋한다 (DATA_SCHEMA.md 5.1). */
export const ACTIVITY_RELATIVE_PATH = '.harness/activity.json';
