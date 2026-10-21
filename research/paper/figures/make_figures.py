"""KSC 원고 그림 1 — 세 패널 (a) 결정 전 코드 쓰기 (b) 진행 결과 구성 (c) 셸 전위 깔때기.

입력: research/hook-vs-prompt/results/<블록>/episodes.csv (에피소드 단위, 조건 4 × 과제 10 × 3회)
출력: fig1.pdf (원고용, 2단 폭 figure*), fig1.png (미리보기), fig_heatmap.pdf (부록 후보)

사용: python3 -I make_figures.py ../../hook-vs-prompt/results/ksc
"""

import csv
import math
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager  # noqa: E402

CONDS = ["A", "B", "C", "Cp"]
COND_LABEL = {"A": "A 지시 없음", "B": "B 프롬프트", "C": "C hook", "Cp": "C′ hook+자동승인"}
# 흑백 인쇄·색각 이상에서도 구분되게: 명도 차 + 무늬. 조건 색은 세 패널에서 같다.
COND_FILL = {"A": "#ffffff", "B": "#bdbdbd", "C": "#636363", "Cp": "#252525"}
COND_HATCH = {"A": "", "B": "", "C": "", "Cp": "///"}
PROG_ORDER = ["P0", "P1", "P2", "P3"]
PROG_LABEL = {"P0": "진행 없음·비정상 종료", "P1": "결정 요청", "P2": "파일 변경(과제 미통과)", "P3": "과제 검사 통과"}
PROG_FILL = {"P0": "#000000", "P1": "#7f7f7f", "P2": "#c7c7c7", "P3": "#ffffff"}
Z95 = 1.959963984540054


def setup_fonts() -> None:
    # 본문과 같은 나눔고딕(양식의 함초롬돋움 같은 고딕). macOS 는 시스템 자산 폴더에 둔다 — fc-match 로 찾는다
    nanum = subprocess.run(["fc-match", "-f", "%{file}", "Nanum Gothic"], capture_output=True, text=True, check=False).stdout.strip()
    for path in [nanum, "/System/Library/Fonts/AppleSDGothicNeo.ttc"]:
        if path and Path(path).exists():
            font_manager.fontManager.addfont(path)
    # 양식: 글자 9pt 이상 — 그림은 180mm 로 그려 본문에 거의 같은 크기(0.95\textwidth ≈ 180.5mm)로 들어간다
    plt.rcParams.update(
        {
            "font.family": ["Nanum Gothic", "Apple SD Gothic Neo"],
            "axes.unicode_minus": False,  # 한글 글꼴의 마이너스 기호 깨짐 방지
            "font.size": 9,
            "axes.titlesize": 9.5,
            "axes.labelsize": 9,
            "xtick.labelsize": 9,
            "ytick.labelsize": 9,
            "legend.fontsize": 9,
            "pdf.fonttype": 42,  # 글자를 윤곽선이 아닌 글꼴로 — PDF 안에서 검색·복사 가능
            "axes.spines.top": False,
            "axes.spines.right": False,
        }
    )


def wilson(k: int, n: int) -> tuple[float, float]:
    """0/n·n/n 에서도 구간이 0·1 밖으로 나가지 않는 Wilson 점수 구간."""
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + Z95**2 / n
    c = (p + Z95**2 / (2 * n)) / d
    h = Z95 * math.sqrt(p * (1 - p) / n + Z95**2 / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def load(results_dir: Path) -> dict[str, list[dict[str, str]]]:
    with (results_dir / "episodes.csv").open(encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    # 재판정(DESIGN N7)이 있으면 진행 등급·우회는 코딩값을 쓴다 — 규칙 기반 PROG_auto·휴리스틱 BYPASS 대신
    recode = results_dir / "coding" / "recode_episodes.csv"
    if recode.exists():
        with recode.open(encoding="utf-8") as fh:
            coded = {r["runId"]: r for r in csv.DictReader(fh)}
        missing = [r["runId"] for r in rows if r["runId"] not in coded]
        if missing:
            raise SystemExit(f"재판정 값 없음: {missing[:3]}")
        rows = [{**r, "PROG": coded[r["runId"]]["P_end"], "BYPASS_FIG": coded[r["runId"]]["BYPASS_coded"]} for r in rows]
    else:
        rows = [{**r, "PROG": r["PROG_auto"], "BYPASS_FIG": r["BYPASS"]} for r in rows]
    by: dict[str, list[dict[str, str]]] = defaultdict(list)
    for r in rows:
        by[r["cond"]].append(r)
    missing = [c for c in CONDS if not by[c]]
    if missing:
        raise SystemExit(f"조건 없음: {missing}")
    return by


def count(rows: list[dict[str, str]], key: str) -> int:
    return sum(r[key] == "1" for r in rows)


def panel_rates(ax, by) -> None:
    """(a) 결정 전 코드 쓰기 — 점 + Wilson 95% 구간. 비율이라 y 는 0~100% 고정."""
    for i, c in enumerate(CONDS):
        n = len(by[c])
        k = count(by[c], "V_disk_code_t1")
        lo, hi = wilson(k, n)
        ax.bar(i, k / n * 100, width=0.62, color=COND_FILL[c], hatch=COND_HATCH[c], edgecolor="black", linewidth=0.6)
        # 부동소수 오차로 음수가 되지 않게 0 에서 자른다 (k=n 일 때 hi≈1)
        ax.errorbar(i, k / n * 100, yerr=[[max(0.0, k / n * 100 - lo * 100)], [max(0.0, hi * 100 - k / n * 100)]], color="black", capsize=2, linewidth=0.8)
    # 한 단 폭에서는 k/n 이 서로 겹친다 — 조건 이름만. k/n 은 표 1 에 있다
    ax.set_xticks(range(len(CONDS)), ["A", "B", "C", "C′"])
    ax.set_ylim(0, 105)
    ax.set_yticks([0, 50, 100], ["0%", "50%", "100%"])
    ax.set_title("(a) 결정 전 코드 쓰기")


def panel_progress(ax, by) -> None:
    """(b) 진행 결과 — 100% 누적 막대. 범주가 서로 배타적이고 합이 n 이라 누적이 맞다."""
    left = [0.0] * len(CONDS)
    for p in PROG_ORDER:
        vals = []
        for c in CONDS:
            n = len(by[c])
            vals.append(Counter(r["PROG"] for r in by[c])[p] / n * 100)
        ax.barh(range(len(CONDS)), vals, left=left, color=PROG_FILL[p], edgecolor="black", linewidth=0.6, label=PROG_LABEL[p], height=0.8)
        for i, v in enumerate(vals):
            if v >= 18:  # 9pt 숫자가 칸 안에 들어가는 폭만
                ax.text(left[i] + v / 2, i, f"{v:.0f}", ha="center", va="center", fontsize=9, color="white" if PROG_FILL[p] in ("#000000", "#7f7f7f") else "black")
        left = [a + b for a, b in zip(left, vals)]
    ax.set_yticks(range(len(CONDS)), ["A", "B", "C", "C′"])
    ax.invert_yaxis()
    ax.set_xlim(0, 100)
    ax.set_xticks([0, 50, 100], ["0%", "50%", "100%"])
    ax.set_title("(b) 진행 결과 구성")
    ax.legend(ncol=2, loc="upper center", bbox_to_anchor=(0.5, -0.36), frameon=False, handlelength=1.0, columnspacing=0.8)


def panel_funnel(ax, by) -> None:
    """(c) 셸 전위 깔때기 — C 와 C′ 만. 같은 단계의 두 조건을 나란히 놓아 'ask 정책' 차이만 보이게."""
    stages = [("에피소드", None), ("파일 도구 거부", "FT_denied"), ("거부 뒤 셸 쓰기", "BYPASS_FIG"), ("디스크에 남음", "BYPASS_ok")]
    y = list(range(len(stages)))
    for j, c in enumerate(["C", "Cp"]):
        vals = [len(by[c]) if key is None else count(by[c], key) for _, key in stages]
        offs = [v + (0.18 if j == 0 else -0.18) for v in y]
        ax.barh(offs, vals, height=0.34, color=COND_FILL[c], hatch=COND_HATCH[c], edgecolor="black", linewidth=0.6, label=COND_LABEL[c])
        for yy, v in zip(offs, vals):
            ax.text(v + 0.6, yy, str(v), va="center", fontsize=9)
    ax.set_yticks(y, [s for s, _ in stages])
    ax.invert_yaxis()
    ax.set_xlim(0, 35)
    ax.set_xlabel("에피소드 수 (조건당 30)")
    ax.set_title("(c) 셸 경로 전위 (C 대 C′)")
    # 9pt 범례는 막대와 겹친다 — (b) 처럼 축 아래로
    ax.legend(loc="upper center", bbox_to_anchor=(0.35, -0.52), frameon=False, handlelength=1.0)


def heatmap(by, out: Path) -> None:
    """부록 후보 — 과제 × 조건 결정 전 코드 쓰기 (k/3). 효과가 과제 하나에 쏠렸는지 본다."""
    tasks = sorted({r["task"] for rs in by.values() for r in rs})
    grid = [[count([r for r in by[c] if r["task"] == t], "V_disk_code_t1") for c in CONDS] for t in tasks]
    fig, ax = plt.subplots(figsize=(2.6, 3.0))
    im = ax.imshow(grid, cmap="Greys", vmin=0, vmax=3, aspect="auto")
    for i, row in enumerate(grid):
        for j, v in enumerate(row):
            ax.text(j, i, str(v), ha="center", va="center", fontsize=9, color="white" if v >= 2 else "black")
    ax.set_xticks(range(len(CONDS)), ["A", "B", "C", "C′"])
    ax.set_yticks(range(len(tasks)), tasks)
    ax.set_title("과제별 결정 전 코드 쓰기 (k/3)")
    fig.colorbar(im, ax=ax, ticks=[0, 1, 2, 3], fraction=0.05)
    fig.tight_layout()
    fig.savefig(out)
    plt.close(fig)


def main() -> None:
    results_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "../../hook-vs-prompt/results/ksc")
    here = Path(__file__).resolve().parent
    setup_fonts()
    by = load(results_dir)
    # 한 단 폭(92.5mm) — 양식은 본문 2단, 그림도 한 단 안에. (c) 셸 전위 단계는 표 2·본문에 있어 뺀다
    fig, axes = plt.subplots(1, 2, figsize=(92 / 25.4, 43 / 25.4), gridspec_kw={"width_ratios": [1.0, 1.25]})
    panel_rates(axes[0], by)
    panel_progress(axes[1], by)
    # (b) 범례는 그림 전체 폭으로 아래에 — 한 칸 폭에는 두 열이 들어가지 않는다
    axes[1].get_legend().remove()
    handles, labels = axes[1].get_legend_handles_labels()
    fig.legend(handles, labels, ncol=2, loc="lower center", frameon=False, handlelength=1.0, columnspacing=0.8)
    fig.subplots_adjust(left=0.13, right=0.95, top=0.86, bottom=0.49, wspace=0.35)
    fig.savefig(here / "fig1.pdf")
    fig.savefig(here / "fig1.png", dpi=220)
    plt.close(fig)
    heatmap(by, here / "fig_heatmap.pdf")
    print(f"fig1.pdf, fig1.png, fig_heatmap.pdf ← {results_dir}")


if __name__ == "__main__":
    main()
