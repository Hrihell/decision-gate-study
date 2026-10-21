// 실행기 진입점 (DESIGN v2 §9). 명령:
//   plan     --block <pilot|main|sens|ksc|sonnet|d> [--seed N]                 블록 계획 출력
//   run      --block <…> --out <dir> [--backend mock|live] [--live] …      실행 + 추출 + 분석
//   analyze  --in <dir>                                                    로그만 다시 분석
//   leakcheck <dir>                                                        공개 전 유출 검사 (값은 출력하지 않는다)
//   authcheck --live                                                       실행 전 인증 확인 (live, 프롬프트 없음)
//
// **실제 Claude 호출은 기본 꺼짐.** `--backend live` 는 `--live` 와 HVP_LIVE_CONFIRM 둘 다 있어야 열린다 (backend.ts).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze, renderSummary } from '../analysis/analyze';
import { renderRateFigure } from '../analysis/figure';
import { toTexMacros } from '../analysis/texMacros';
import { buildCodingSheet, CODES, cohenKappa, recallByCode, collectBashCommands, keyToCsv, mergeCodes, parseCsv, scoreCoding, sheetToCsv } from '../analysis/bashCoding';
import { extractEpisode, parseJsonl, toCsv, type EpisodeRow } from '../analysis/extract';
import { evaluatePilotGate, renderPilotGate } from '../analysis/pilotGate';
import { robustSummary, type RobustEpisode } from '../analysis/robust';
import { assertLiveAllowed, resolveBackendChoice, type Backend } from './backends/backend';
import { createMockBackend } from './backends/mock';
import { personaFor } from './backends/persona';
import { scrubEnv } from './env';
import { isConditionId } from './conditions';
import { assistantTexts, judgeProbe, PROBES, tapBackend, type ProbeKind } from './probe';
import { runEpisode, type EpisodeEnv, type EpisodeSummary } from './episode';
import { leakContextFromEnv, scanDir } from './leakcheck';
import { LIMITS, MODELS } from './options';
import { createGroupSpawner, systemProcessControl } from './procs';
import { BLOCKS, buildSchedule, keyOfLogFile, makeRunId, remainingBlocks, type BlockName, type ScheduledEpisode } from './schedule';
import { loadTaskSet } from './tasks';
import { exploreN8Command, recodeAgreeCommand, recodeScoreCommand, recodeSheetCommand } from './reviewCommands';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_ROOT = path.resolve(PKG_ROOT, '../..');
const DEFAULT_SEED = 20261008;
const DEFAULT_BUDGET_USD = 60;
const INIT_TIMEOUT_MS = 60_000;
const MOCK_BANNER =
  '> ⚠️ **mock 백엔드 dry-run 산출물이다.** 실제 Claude 호출 0회. 에이전트 행동은 시드 고정 가상 스크립트(src/backends/persona.ts)이므로 **수치에 아무 의미가 없다** — 파이프라인이 끝까지 도는지만 보인다.';

/** 원고·해시에 넣는 소스. 앱 모듈은 고치지 않고 import 한다 — 그 sha 로 "같은 판정" 을 증명한다. */
const SOURCE_FILES = [
  'src/safety.ts', 'src/observe.ts', 'src/policy.ts', 'src/conditions.ts', 'src/options.ts', 'src/hooks.ts', 'src/episode.ts',
  'analysis/extract.ts', 'analysis/analyze.ts', 'analysis/stats.ts',
  '../../src/main/gates/hooks.ts', '../../src/main/gates/decide.ts', '../../src/main/gates/bashCommand.ts',
  '../../src/main/gates/toolInputs.ts', '../../src/main/session/question.ts', '../../src/main/plan/store.ts',
];

type Args = { readonly _: string[]; readonly flags: Readonly<Record<string, string | true>> };

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true;
    else {
      flags[a.slice(2)] = next;
      i += 1;
    }
  }
  return { _: positional, flags };
}

const flag = (args: Args, name: string): string | undefined => {
  const v = args.flags[name];
  return typeof v === 'string' ? v : undefined;
};

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

const dirSha = (dir: string): string => {
  const walk = (d: string): string[] =>
    readdirSync(d).sort().flatMap((n) => {
      const p = path.join(d, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  return sha256(walk(dir).map((f) => `${path.relative(dir, f)}:${sha256(readFileSync(f))}`).join('\n'));
};

const git = (...args: string[]): string => {
  try {
    return execFileSync('git', args, { cwd: PKG_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

const sdkVersion = (): string => {
  try {
    return (JSON.parse(readFileSync(path.join(PKG_ROOT, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
};

/** 실행 폴더 뿌리는 OS 임시 폴더나 이 worktree 안만 허용한다. */
function resolveTmpRoot(requested: string | undefined): string {
  const base = realpathSync(os.tmpdir());
  const root = requested === undefined ? path.join(base, 'hvp-runs') : path.resolve(requested);
  mkdirSync(root, { recursive: true });
  const real = realpathSync(root);
  const inside = (parent: string): boolean => !path.relative(parent, real).startsWith('..');
  if (!inside(base) && !inside(realpathSync(APP_ROOT))) throw new Error('실행 폴더 뿌리는 OS 임시 폴더나 이 worktree 안이어야 한다');
  return real;
}

const seedOf = (seed: number, ...parts: string[]): number => parseInt(sha256(`${seed}:${parts.join(':')}`).slice(0, 8), 16);

// ---------------------------------------------------------------- analyze

function analyzeDir(outDir: string, banner: string, isPilot: boolean): void {
  const logDir = path.join(outDir, 'logs');
  const files = readdirSync(logDir).filter((f) => f.endsWith('.jsonl')).sort();
  const episodes = files.map((f) => {
    const events = parseJsonl(readFileSync(path.join(logDir, f), 'utf8'));
    return { file: f, events, row: extractEpisode(events) };
  });
  const rows: EpisodeRow[] = episodes.map((e) => e.row);
  writeFileSync(path.join(outDir, 'episodes.csv'), toCsv(rows));
  const report = analyze(rows);
  writeFileSync(path.join(outDir, 'analysis.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(outDir, 'summary.md'), renderSummary(report, banner));
  // 원고 숫자 매크로 — research/paper/*.tex 가 \input 한다
  writeFileSync(path.join(outDir, 'results.tex'), toTexMacros(report));
  // 원고 그림 1 (2~3쪽이라 하나) — 결정 전 코드 쓰기·셸 쓰기 시도·헛돎
  writeFileSync(
    path.join(outDir, 'figure.svg'),
    renderRateFigure(report.descriptive as never, [
      { key: 'V_disk_code_t1', label: '결정 전 코드 쓰기' },
      { key: 'BASH_W', label: '셸 쓰기 시도' },
      { key: 'P0', label: '진행 없음(P0)' },
    ]),
  );
  if (isPilot) writeFileSync(path.join(outDir, 'pilot_gate.md'), renderPilotGate(evaluatePilotGate(episodes), banner));
  const manifest = Object.fromEntries(
    ['episodes.csv', 'analysis.json', 'summary.md', 'figure.svg', 'results.tex', ...(isPilot ? ['pilot_gate.md'] : []), ...files.map((f) => `logs/${f}`)].map((f) => [
      f,
      sha256(readFileSync(path.join(outDir, f))),
    ]),
  );
  writeFileSync(path.join(outDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`분석: 에피소드 ${rows.length}개 → ${path.relative(process.cwd(), outDir) || '.'}\n`);
}

// ---------------------------------------------------------------- run

interface RunState {
  costUsd: number;
  stopReason: string | null;
}

interface EpisodeEnvInput {
  readonly backend: Backend;
  readonly tasks: EpisodeEnv['tasks'];
  readonly fixturesDir: string;
  readonly tmpRoot: string;
  readonly outDir: string;
  readonly live: boolean;
  readonly model: string;
  readonly maxBudgetUsd: number;
  readonly meta: EpisodeEnv['meta'];
}

const episodeEnvFor = (i: EpisodeEnvInput): EpisodeEnv => ({
  backend: i.backend,
  tasks: i.tasks,
  fixturesDir: i.fixturesDir,
  tmpRoot: i.tmpRoot,
  logDir: path.join(i.outDir, 'logs'),
  ...(i.live ? { archiveDir: path.join(i.outDir, 'archives'), makeSpawner: createGroupSpawner } : {}),
  model: i.model,
  maxBudgetUsd: i.maxBudgetUsd,
  timeoutMs: LIMITS.episodeTimeoutMs,
  initTimeoutMs: INIT_TIMEOUT_MS,
  envSource: process.env,
  home: os.homedir(),
  user: os.userInfo().username,
  proc: systemProcessControl,
  now: () => Date.now(),
  meta: i.meta,
});

/**
 * 재개 (DESIGN N8): 끝까지 기록된(run_end, 인프라 실패·미무장 아님) 에피소드 키를 모으고,
 * 중간에 끊긴 로그는 logs-incomplete/ 로 옮겨 분석에서 뺀다. 지우지 않는다.
 */
function resumeState(outDir: string): { done: Set<string>; moved: string[] } {
  const logDir = path.join(outDir, 'logs');
  const done = new Set<string>();
  const moved: string[] = [];
  for (const f of readdirSync(logDir).filter((x) => x.endsWith('.jsonl')).sort()) {
    const key = keyOfLogFile(f);
    const lines = readFileSync(path.join(logDir, f), 'utf8').trim().split('\n');
    const last = parseJsonl(lines.at(-1) ?? '')[0];
    const finished = last?.type === 'run_end';
    if (!finished) {
      mkdirSync(path.join(outDir, 'logs-incomplete'), { recursive: true });
      renameSync(path.join(logDir, f), path.join(outDir, 'logs-incomplete', f));
      moved.push(f);
      continue;
    }
    if (key !== null && last.outcome !== 'infra' && last.outcome !== 'not_armed') done.add(key);
  }
  return { done, moved };
}

async function runCommand(args: Args): Promise<void> {
  const blockName = (flag(args, 'block') ?? 'pilot') as BlockName;
  if (!(blockName in BLOCKS)) throw new Error(`모르는 블록: ${blockName}`);
  const backendChoice = resolveBackendChoice(flag(args, 'backend'), { live: args.flags.live === true }, process.env);
  const outDir = path.resolve(flag(args, 'out') ?? path.join('runs', `${blockName}-${new Date().toISOString().slice(0, 10)}`));
  const seed = Number(flag(args, 'seed') ?? DEFAULT_SEED);
  const concurrency = Math.max(1, Math.min(4, Number(flag(args, 'concurrency') ?? 1)));
  const budgetCap = Number(flag(args, 'budget-usd') ?? DEFAULT_BUDGET_USD);
  const modelKey = BLOCKS[blockName].model;
  const model = MODELS[modelKey];
  const maxBudgetUsd = Number(flag(args, 'max-budget-usd') ?? LIMITS.maxBudgetUsd[modelKey]);

  const gitHead = git('rev-parse', 'HEAD');
  // 산출물 폴더(results/)는 빼고 본다 — dry-run 을 다시 만들 때 지운 산출물이 코드 변경으로 잡히지 않게
  const gitDirty = git('status', '--porcelain', '--', '.', ':(exclude)results') !== '';
  // 재현성 (DESIGN §8.2): live 는 작업 트리가 깨끗해야 시작한다
  if (backendChoice === 'live' && gitDirty) throw new Error('작업 트리가 더럽다 — 커밋한 뒤 실행한다');

  const { set: tasks, raw: tasksRaw } = loadTaskSet(path.join(PKG_ROOT, 'tasks/tasks.json'));
  const fixturesDir = path.join(PKG_ROOT, 'fixtures');
  const tmpRoot = resolveTmpRoot(flag(args, 'tmp-root'));
  const liveBackend: Backend | undefined =
    backendChoice === 'live' ? (await import('./backends/live')).createLiveBackend() : undefined;

  mkdirSync(path.join(outDir, 'logs'), { recursive: true });
  const resume = args.flags.resume === true ? resumeState(outDir) : null;
  const meta = {
    seed,
    blockName,
    gitHead,
    gitDirty,
    sdkVersion: sdkVersion(),
    node: process.version,
    os: `${os.platform()} ${os.release()} ${os.arch()}`,
    tasksSha256: sha256(tasksRaw),
    fixturesSha256: dirSha(fixturesDir),
    sourcesSha256: Object.fromEntries(SOURCE_FILES.map((f) => [f, sha256(readFileSync(path.join(PKG_ROOT, f)))])),
    ...(resume === null ? {} : { resumed: { done: resume.done.size, movedIncomplete: resume.moved } }),
  };

  const baseEnv = (backend: Backend): EpisodeEnv =>
    episodeEnvFor({ backend, tasks, fixturesDir, tmpRoot, outDir, live: backendChoice === 'live', model, maxBudgetUsd, meta });

  const backendFor = (ep: ScheduledEpisode): Backend =>
    liveBackend ?? createMockBackend({ behavior: personaFor(ep.task), seed: seedOf(seed, ep.task, ep.cond, String(ep.rep)) });

  const state: RunState = { costUsd: 0, stopReason: null };
  const summaries: EpisodeSummary[] = [];
  const planned = buildSchedule(blockName, tasks.tasks.map((t) => t.id), seed);
  const blocks = resume === null ? planned : remainingBlocks(planned, resume.done);
  if (resume !== null) process.stdout.write(`재개: 끝난 ${resume.done.size}개 건너뜀, 끊긴 기록 ${resume.moved.length}개 → logs-incomplete/, 남은 ${blocks.flat().length}개\n`);

  const runOne = async (ep: ScheduledEpisode, rerunOf: string | null): Promise<EpisodeSummary> => {
    const task = tasks.tasks.find((t) => t.id === ep.task);
    if (task === undefined) throw new Error(`과제 없음: ${ep.task}`);
    const runId = rerunOf === null ? ep.runId : makeRunId(ep.blockName, ep.block, ep.task, ep.cond, ep.rep);
    const s = await runEpisode({ runId, block: ep.block, task, cond: ep.cond, rep: ep.rep, rerunOf }, baseEnv(backendFor(ep)));
    summaries.push(s);
    state.costUsd += s.costUsd; // 에피소드 비용은 마지막 result 의 누적값 (M3) — 이중 계산 없음
    process.stdout.write(`${s.runId} ${s.outcome} ${s.reason} $${s.costUsd.toFixed(4)}\n`);
    if (s.usageLimit) state.stopReason = 'usage_limit';
    if (s.authFailure) state.stopReason = 'auth_failure';
    return s;
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (state.stopReason !== null) return;
      if (state.costUsd >= budgetCap) {
        state.stopReason = state.stopReason ?? 'budget_cap';
        return;
      }
      const block = blocks[next];
      next += 1;
      if (block === undefined) return;
      for (const ep of block) {
        if (state.stopReason !== null) return;
        const s = await runOne(ep, null);
        // M5: 인프라 실패·미무장은 1회 재실행 (사용량 한도·인증 실패면 실행 전체를 멈춘다)
        if ((s.outcome === 'infra' || s.outcome === 'not_armed') && state.stopReason === null) await runOne(ep, s.runId);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  writeFileSync(
    path.join(outDir, 'run_state.json'),
    `${JSON.stringify({ blockName, backend: backendChoice, seed, model, maxBudgetUsd, budgetCap, costUsd: state.costUsd, stopReason: state.stopReason, ...(resume === null ? {} : { resumed: meta.resumed }), episodes: summaries.map((s) => ({ ...s, logFile: path.basename(s.logFile) })) }, null, 2)}\n`,
  );
  // 비어 있을 때만 지운다 — 다른 실행이 같은 뿌리를 쓰고 있을 수 있다
  try {
    rmdirSync(tmpRoot);
  } catch {
    // 비어 있지 않다
  }
  const banner = backendChoice === 'mock' ? MOCK_BANNER : `> live 실행 (${model}). 정지 사유: ${state.stopReason ?? '없음'}`;
  analyzeDir(outDir, banner, blockName === 'pilot');
  if (state.stopReason !== null) process.stdout.write(`정지: ${state.stopReason}\n`);
}

// ---------------------------------------------------------------- 그 밖의 명령

async function authcheckCommand(args: Args): Promise<void> {
  assertLiveAllowed({ live: args.flags.live === true }, process.env);
  const { checkAuthenticated } = await import('./backends/live');
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const dir = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), 'hvp-auth-')));
  try {
    const { env } = scrubEnv(process.env, {});
    const ok = await checkAuthenticated(
      { cwd: dir, settingSources: [], strictMcpConfig: true, permissionMode: 'default', tools: [], persistSession: false, env: { ...env } },
      sdk,
    );
    // 이메일은 출력하지 않는다 — 참·거짓만 (M2)
    process.stdout.write(`authenticated: ${ok}\n`);
    if (!ok) process.exitCode = 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function leakcheckCommand(args: Args): void {
  const dir = path.resolve(args._[1] ?? 'results');
  const findings = scanDir(dir, leakContextFromEnv(process.env, os.homedir(), os.userInfo().username));
  for (const f of findings) process.stdout.write(`${f.file}:${f.line} ${f.kind}\n`);
  process.stdout.write(`유출 검사: ${findings.length}건\n`);
  if (findings.length > 0) process.exitCode = 1;
}

function planCommand(args: Args): void {
  const blockName = (flag(args, 'block') ?? 'pilot') as BlockName;
  const { set } = loadTaskSet(path.join(PKG_ROOT, 'tasks/tasks.json'));
  const blocks = buildSchedule(blockName, set.tasks.map((t) => t.id), Number(flag(args, 'seed') ?? DEFAULT_SEED));
  for (const b of blocks) process.stdout.write(`${b.map((e) => `${e.task}/${e.cond}/r${e.rep}`).join('  ')}\n`);
  process.stdout.write(`블록 ${blocks.length}개, 에피소드 ${blocks.flat().length}개\n`);
}

// ---------------------------------------------------------------- Bash 눈가림 코딩 (DESIGN §4.3, N5)

/** 시트(id·명령)와 열쇠(조건·휴리스틱)를 따로 쓴다. 코더에게는 시트만 준다. */
function bashSheetCommand(args: Args): void {
  const dir = path.resolve(flag(args, 'in') ?? '');
  const logDir = path.join(dir, 'logs');
  const episodes = readdirSync(logDir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => ({ events: parseJsonl(readFileSync(path.join(logDir, f), 'utf8')) }));
  const collected = collectBashCommands(episodes);
  const { sheet, key } = buildCodingSheet(collected, Number(flag(args, 'n') ?? 100), Number(flag(args, 'seed') ?? DEFAULT_SEED));
  const out = path.join(dir, 'coding');
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'bash_sheet.csv'), sheetToCsv(sheet));
  writeFileSync(path.join(out, 'bash_key.csv'), keyToCsv(key));
  process.stdout.write(`고유 명령 ${collected.length}개 중 ${sheet.length}개 → ${path.join(out, 'bash_sheet.csv')} (코드 열을 채운다: ${CODES.join(' ')})\n`);
}

const readCodes = (file: string): Map<string, string> =>
  new Map(parseCsv(readFileSync(file, 'utf8')).slice(1).filter((r) => (r[0] ?? '') !== '').map((r) => [r[0] as string, (r[1] ?? '').trim()]));

/** 두 코더 일치도(6범주·쓰기 여부 2범주 κ)와 불일치 시트. 불일치 시트의 final 열을 저자가 채운다. */
function bashAgreeCommand(args: Args): void {
  const out = path.join(path.resolve(flag(args, 'in') ?? ''), 'coding');
  const a = readCodes(path.join(out, flag(args, 'a') ?? 'coder_a_opus.csv'));
  const b = readCodes(path.join(out, flag(args, 'b') ?? 'coder_b_sonnet.csv'));
  for (const [id, code] of [...a, ...b]) if (!(CODES as readonly string[]).includes(code)) throw new Error(`${id}: 모르는 코드 ${code}`);
  const binary = (m: Map<string, string>): Map<string, string> => new Map([...m].map(([id, c]) => [id, c === '?' ? '?' : c.startsWith('W-') ? 'W' : 'R']));
  const report = { categories: cohenKappa(a, b), writeOrNot: cohenKappa(binary(a), binary(b)) };
  writeFileSync(path.join(out, 'agreement.json'), `${JSON.stringify(report, null, 2)}\n`);
  const sheet = new Map(parseCsv(readFileSync(path.join(out, 'bash_sheet.csv'), 'utf8')).slice(1).map((r) => [r[0] ?? '', r[1] ?? '']));
  const diff = [...a].filter(([id, c]) => b.get(id) !== c).map(([id, c]) => ({ id, command: sheet.get(id) ?? '', a: c, b: b.get(id) ?? '' }));
  const cell = (s: string): string => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  writeFileSync(path.join(out, 'disagreements.csv'), ['id,command,coder_a,coder_b,final', ...diff.map((d) => `${d.id},${cell(d.command)},${d.a},${d.b},`)].join('\n') + '\n');
  process.stdout.write(`${JSON.stringify(report)}\n불일치 ${diff.length}개 → ${path.join(out, 'disagreements.csv')} (final 열을 채운다)\n`);
}

function bashScoreCommand(args: Args): void {
  const out = path.join(path.resolve(flag(args, 'in') ?? ''), 'coding');
  const sheet = parseCsv(readFileSync(path.join(out, 'bash_sheet.csv'), 'utf8')).slice(1);
  const keyRows = parseCsv(readFileSync(path.join(out, 'bash_key.csv'), 'utf8')).slice(1);
  let codes = new Map(sheet.map((r) => [r[0] ?? '', r[2] ?? '']));
  const disagreeFile = path.join(out, 'disagreements.csv');
  if (existsSync(disagreeFile)) {
    const adjudicated = new Map(parseCsv(readFileSync(disagreeFile, 'utf8')).slice(1).filter((r) => (r[0] ?? '') !== '').map((r) => [r[0] as string, (r[4] ?? '').trim()]));
    const merged = mergeCodes(readCodes(path.join(out, flag(args, 'a') ?? 'coder_a_opus.csv')), readCodes(path.join(out, flag(args, 'b') ?? 'coder_b_sonnet.csv')), adjudicated);
    if (merged.pending.length > 0) throw new Error(`판정이 빠진 불일치: ${merged.pending.join(' ')}`);
    codes = merged.final;
  }
  const score = scoreCoding(codes, keyRows.map((r) => ({ id: r[0] ?? '', heuristicWrites: r[3] === '1' })));
  const keyList = keyRows.map((r) => ({ id: r[0] ?? '', heuristicWrites: r[3] === '1' }));
  const agreementFile = path.join(out, 'agreement.json');
  const full = {
    score,
    byCode: recallByCode(codes, keyList),
    ...(existsSync(agreementFile) ? { agreement: JSON.parse(readFileSync(agreementFile, 'utf8')) as unknown } : {}),
  };
  writeFileSync(path.join(out, 'bash_score.json'), `${JSON.stringify(full, null, 2)}\n`);
  // 원고 매크로: \R{coding.score.precision.pct} 등 — results.tex 뒤에 붙여 쓴다
  writeFileSync(path.join(out, 'coding.tex'), toTexMacros({ coding: full }).split('\n').filter((l) => !l.startsWith('\\newcommand{\\R}')).join('\n'));
  process.stdout.write(`${JSON.stringify(score)}\n`);
}

// ---------------------------------------------------------------- probe (관문 6.5-6)

/** B 의 append 가 모델 문맥에 들어갔는지 1턴 질의로 확인한다. A 는 대조군. 1턴 답만 판정한다. */
async function probeCommand(args: Args): Promise<void> {
  const backendChoice = resolveBackendChoice(flag(args, 'backend'), { live: args.flags.live === true }, process.env);
  const outDir = path.resolve(flag(args, 'out') ?? path.join('runs', `probe-${new Date().toISOString().slice(0, 10)}`));
  const conds = (flag(args, 'cond') ?? 'B,A').split(',').filter(isConditionId);
  const kind = (flag(args, 'kind') ?? 'project') as ProbeKind;
  if (!(kind in PROBES)) throw new Error(`모르는 확인 질의: ${kind}`);
  const probe = PROBES[kind];
  if (backendChoice === 'live' && git('status', '--porcelain', '--', '.', ':(exclude)results') !== '') throw new Error('작업 트리가 더럽다 — 커밋한 뒤 실행한다');
  const { set: tasks } = loadTaskSet(path.join(PKG_ROOT, 'tasks/tasks.json'));
  const base = tasks.tasks.find((t) => t.id === 'T01');
  if (base === undefined) throw new Error('과제 없음: T01');
  const inner: Backend = backendChoice === 'live' ? (await import('./backends/live')).createLiveBackend() : createMockBackend({ behavior: personaFor('T01'), seed: 1 });
  mkdirSync(path.join(outDir, 'logs'), { recursive: true });
  const results = [];
  for (const cond of conds) {
    const texts: string[] = [];
    let resultsSeen = 0;
    const backend = tapBackend(inner, (m) => {
      if (typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'result') resultsSeen += 1;
      if (resultsSeen === 0) texts.push(...assistantTexts(m));
    });
    const env = episodeEnvFor({ backend, tasks, fixturesDir: path.join(PKG_ROOT, 'fixtures'), tmpRoot: resolveTmpRoot(flag(args, 'tmp-root')), outDir, live: backendChoice === 'live', model: MODELS.haiku, maxBudgetUsd: 0.3, meta: { probe: true, gitHead: git('rev-parse', 'HEAD') } });
    const s = await runEpisode({ runId: makeRunId('probe', 1, 'T01', cond, 1), block: 1, task: { ...base, promptKo: probe.prompt }, cond, rep: 1, rerunOf: null }, env);
    const answer = texts.join(' ');
    results.push({ cond, outcome: s.outcome, quoted: judgeProbe(texts, probe.expected), answerHead: answer.slice(0, 200), answerSha256: sha256(answer) });
  }
  writeFileSync(path.join(outDir, 'probe_result.json'), `${JSON.stringify({ kind, expected: probe.expected, results }, null, 2)}\n`);
  for (const r of results) process.stdout.write(`${r.cond} ${r.outcome} quoted=${r.quoted}\n`);
}

/** 모의 리뷰 ② (2026-10-09) 사후 민감도: episodes.csv(V_disk_code_t1) + coding/recode_episodes.csv(P_end·P_turn1) → coding/robust.{json,tex} */
function robustCommand(args: Args): void {
  const dir = path.resolve(flag(args, 'in') ?? '');
  const table = (file: string): Record<string, string>[] => {
    const [head = [], ...rows] = parseCsv(readFileSync(file, 'utf8'));
    return rows.filter((r) => (r[0] ?? '') !== '').map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
  };
  const grades = new Map(table(path.join(dir, 'coding', 'recode_episodes.csv')).map((r) => [r.runId as string, r]));
  const episodes: RobustEpisode[] = table(path.join(dir, 'episodes.csv')).map((r) => {
    const g = grades.get(r.runId as string);
    if (g === undefined) throw new Error(`재판정 등급 없음: ${r.runId}`);
    return { task: r.task as string, cond: r.cond as string, vT1: r.V_disk_code_t1 === '1', pEnd: g.P_end as string, pTurn1: g.P_turn1 as string };
  });
  const summary = robustSummary(episodes);
  const out = path.join(dir, 'coding');
  writeFileSync(path.join(out, 'robust.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(path.join(out, 'robust.tex'), toTexMacros({ robust: summary }).split('\n').filter((l) => !l.startsWith('\\newcommand{\\R}')).join('\n'));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

/** --prior a,b — 이미 코딩한 다른 실행 폴더 (같은 명령은 그 확정값을 쓴다) */
const priorDirsOf = (args: Args): string[] => (flag(args, 'prior') ?? '').split(',').filter((d) => d !== '').map((d) => path.resolve(d));

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args._[0]) {
    case 'run':
      return runCommand(args);
    case 'analyze': {
      const dir = path.resolve(flag(args, 'in') ?? 'results/dryrun');
      return analyzeDir(dir, existsSync(path.join(dir, 'run_state.json')) && readFileSync(path.join(dir, 'run_state.json'), 'utf8').includes('"backend": "mock"') ? MOCK_BANNER : '> live 실행 분석', args.flags.pilot !== undefined || dir.includes('pilot') || dir.includes('dryrun'));
    }
    case 'leakcheck':
      return leakcheckCommand(args);
    case 'authcheck':
      return authcheckCommand(args);
    case 'plan':
      return planCommand(args);
    case 'probe':
      return probeCommand(args);
    case 'bash-sheet':
      return bashSheetCommand(args);
    case 'bash-agree':
      return bashAgreeCommand(args);
    case 'bash-score':
      return bashScoreCommand(args);
    case 'recode-sheet':
      return recodeSheetCommand(path.resolve(flag(args, 'in') ?? ''), Number(flag(args, 'seed') ?? DEFAULT_SEED), priorDirsOf(args));
    case 'recode-agree':
      return recodeAgreeCommand(path.resolve(flag(args, 'in') ?? ''));
    case 'recode-score':
      return recodeScoreCommand(path.resolve(flag(args, 'in') ?? ''), priorDirsOf(args));
    case 'robust':
      return robustCommand(args);
    case 'explore-n8':
      return exploreN8Command(path.resolve(flag(args, 'ksc') ?? ''), path.resolve(flag(args, 'd') ?? ''), path.resolve(flag(args, 'sonnet') ?? ''), path.resolve(flag(args, 'out') ?? 'results/n8'), flag(args, 'e') === undefined ? undefined : path.resolve(flag(args, 'e') as string), flag(args, 'f') === undefined ? undefined : path.resolve(flag(args, 'f') as string), flag(args, 'h') === undefined ? undefined : path.resolve(flag(args, 'h') as string));
    default:
      process.stdout.write('사용법: cli.mjs <plan|run|analyze|leakcheck|authcheck|bash-sheet|bash-agree|bash-score|recode-sheet|recode-agree|recode-score|probe> … (README 의 RUNBOOK 참조)\n');
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
