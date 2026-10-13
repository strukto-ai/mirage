"""Measure shell coverage using only the shared RAM integration battery.

Run after building core/node: python integ/shell_coverage.py [--measure].
Unit-test data is never loaded. Both hosts must finish the strict battery before
fresh statement and branch reports are compared with shell_coverage.json.
The two hosts' batteries run at once, each into its own log, printed whole
once both have finished.
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORTS = ROOT / ".cache" / "integ-shell-coverage"


def run(
    argv: list[str], *, cwd: Path = ROOT, env: dict[str, str] | None = None
) -> None:
    subprocess.run(argv, cwd=cwd, env=env, check=True)


def run_together(
    legs: list[tuple[list[str], Path, Path, dict[str, str] | None]],
) -> None:
    """Run every leg at once and print each log whole once all have ended.

    A leg that fails to start, or an interrupted wait, stops and reaps
    every leg already running before the error goes on.

    Args:
        legs (list[tuple[list[str], Path, Path, dict[str, str] | None]]):
            each leg's argv, working directory, log file and environment.
    """
    running: list[tuple[list[str], Path, subprocess.Popen[bytes]]] = []
    try:
        for argv, cwd, log, env in legs:
            with log.open("wb") as out:
                running.append(
                    (
                        argv,
                        log,
                        subprocess.Popen(
                            argv, cwd=cwd, env=env, stdout=out, stderr=out
                        ),
                    )
                )
        codes = [(argv, log, process.wait()) for argv, log, process in running]
    finally:
        for _, _, process in running:
            if process.poll() is None:
                process.kill()
                process.wait()
    for _, log, code in codes:
        print(f"=== {log.name}: exit {code} ===", flush=True)
        sys.stdout.buffer.write(log.read_bytes())
        sys.stdout.flush()
    for argv, _, code in codes:
        if code:
            raise subprocess.CalledProcessError(code, argv)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--measure",
        action="store_true",
        help="report without enforcing floors",
    )
    args = parser.parse_args()
    config = json.loads((ROOT / "integ/shell_coverage.json").read_text())
    sources = config["sources"]
    battery = ["--target", config["target"], "--strict"]
    for case, reason in config["exclude_cases"].items():
        if not reason:
            raise ValueError(f"coverage exclusion needs a reason: {case}")
        print(f"Coverage-only exclusion: {case}: {reason}", flush=True)
        battery.extend(["--exclude-case", case])
    py = REPORTS / "python"
    ts = REPORTS / "typescript"
    py.mkdir(parents=True, exist_ok=True)
    ts.mkdir(parents=True, exist_ok=True)
    env = dict(
        os.environ,
        PYTHONPATH=str(ROOT / "python"),
        COVERAGE_FILE=str(py / ".coverage"),
        PYTHONFAULTHANDLER="1",
        PYTHONUNBUFFERED="1",
    )
    # Explicit erase also prevents a developer's parallel/append settings from
    # pulling old unit-test data into this integration-only run.
    coverage = [sys.executable, "-m", "coverage"]
    run([*coverage, "erase"], env=env)
    include = [
        item
        for source in sources
        for item in (
            "--include",
            f"**/{source}/**",
            "--include",
            f"**/{source}.js",
        )
    ]
    run_together(
        [
            (
                [
                    *coverage,
                    "run",
                    "--branch",
                    "--source="
                    + ",".join(
                        "mirage." + source.replace("/", ".")
                        for source in sources
                    ),
                    "integ/runners/python/main.py",
                    *battery,
                ],
                ROOT,
                REPORTS / "python.log",
                env,
            ),
            (
                [
                    "node",
                    "node_modules/c8/bin/c8.js",
                    "--all",
                    "--allowExternal",
                    "--clean",
                    "--src",
                    "../typescript/packages/core/dist",
                    "--src",
                    "../typescript/packages/node/dist",
                    *include,
                    "--reporter=json",
                    "--reporter=json-summary",
                    "--reports-dir=" + str(ts),
                    "--temp-directory=" + str(ts / "raw"),
                    "node",
                    "--import",
                    "tsx",
                    "runners/typescript/main.ts",
                    *battery,
                ],
                ROOT / "integ",
                REPORTS / "typescript.log",
                None,
            ),
        ]
    )
    run([*coverage, "json", "-o", str(py / "coverage.json")], env=env)
    totals = json.loads((py / "coverage.json").read_text())["totals"]
    summary = json.loads((ts / "coverage-summary.json").read_text())["total"]
    counts = {
        "python": {
            "statements": (totals["covered_lines"], totals["num_statements"]),
            "branches": (totals["covered_branches"], totals["num_branches"]),
        },
        "typescript": {
            metric: (summary[metric]["covered"], summary[metric]["total"])
            for metric in ("statements", "branches")
        },
    }
    failed = False
    for host, metrics in counts.items():
        for metric, (covered, total) in metrics.items():
            if total == 0:
                raise ValueError(f"{host} {metric}: empty coverage report")
            percent = covered * 100 / total
            floor = config["minimum"][host][metric]
            print(
                f"{host} {metric}: {percent:.2f}% ({covered}/{total}); minimum {floor}%"
            )
            failed |= percent < floor
    print(f"Integration-only reports: {REPORTS}")
    return int(failed and not args.measure)


if __name__ == "__main__":
    raise SystemExit(main())
