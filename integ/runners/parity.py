# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

INTEG = Path(__file__).resolve().parents[1]
SHARED_TARGETS = [
    "ram",
    "disk",
    "disk-host-links",
    "redis",
    "ram-history",
    "ram-nested",
    "command-service",
]
S3_TARGETS = ["s3", "s3-prefix", "object-storage-prefix"]
SSH_TARGETS = ["ssh"]
GDRIVE_TARGETS = ["gdrive", "gdrive-folder", "gdrive-shared", "gapps", "gmail"]
GRAPH_TARGETS = ["onedrive", "sharepoint", "sharepoint-prefix"]
MEMORY_TARGETS = ["mem0"]


def load(path: str) -> dict[tuple[str, str], dict]:
    rows = json.loads(Path(path).read_text())
    return {(r["target"], r["id"]): r for r in rows}


def emit_python(out: str, target_args: list[str]) -> int:
    return subprocess.run(
        [
            sys.executable,
            str(INTEG / "runners" / "python" / "main.py"),
            "--emit",
            out,
            *target_args,
        ],
        check=False,
    ).returncode


def emit_typescript(out: str, target_args: list[str]) -> int:
    return subprocess.run(
        [
            "pnpm",
            "exec",
            "tsx",
            "runners/typescript/main.ts",
            "--emit",
            out,
            *target_args,
        ],
        cwd=INTEG,
        check=False,
    ).returncode


def diff_row(a: dict, b: dict) -> list[str]:
    diffs: list[str] = []
    if a["exit"] != b["exit"]:
        diffs.append(f"exit py={a['exit']} ts={b['exit']}")
    if a["stdout"] != b["stdout"]:
        diffs.append(f"stdout py={a['stdout']!r} ts={b['stdout']!r}")
    if a["stderr"] != b["stderr"]:
        diffs.append(f"stderr py={a['stderr']!r} ts={b['stderr']!r}")
    if a["check"] != b["check"]:
        diffs.append(f"check py={a['check']!r} ts={b['check']!r}")
    return diffs


def load_dir(path: Path) -> dict[tuple[str, str], dict]:
    """Every emit a battery job left in one host's directory, merged.

    Args:
        path (Path): a directory of emit files from one host.
    """
    rows: dict[tuple[str, str], dict] = {}
    for file in sorted(path.glob("*.json")):
        rows.update(load(str(file)))
    return rows


def main() -> None:
    default_targets = list(SHARED_TARGETS + GRAPH_TARGETS + MEMORY_TARGETS)
    if os.environ.get("S3_ENDPOINT"):
        default_targets += S3_TARGETS
    if os.environ.get("SSH_HOST"):
        default_targets += SSH_TARGETS
    if os.environ.get("GWS_URL"):
        default_targets += GDRIVE_TARGETS
    args = sys.argv[1:]
    # `--from DIR` diffs the emits the battery jobs already wrote, one
    # subdirectory per host, instead of running both hosts again.
    source = None
    if args[:1] == ["--from"] and len(args) >= 2:
        source = Path(args[1])
        args = args[2:]
    targets = args or default_targets
    failed: list[str] = []
    if source is not None:
        wanted = set(targets)
        py = {
            k: v
            for k, v in load_dir(source / "python").items()
            if k[0] in wanted
        }
        ts = {
            k: v
            for k, v in load_dir(source / "typescript").items()
            if k[0] in wanted
        }
        # A battery job that never uploaded a target's emit drops it from
        # both sides at once, which no ONLY-PY/ONLY-TS row would show.
        missing = sorted(wanted - {k[0] for k in py.keys() | ts.keys()})
        if missing:
            print(
                f"no rows in {source} for: {', '.join(missing)}",
                file=sys.stderr,
            )
            sys.exit(2)
    else:
        target_args: list[str] = []
        for t in targets:
            target_args += ["--target", t]
        with tempfile.TemporaryDirectory() as tmp:
            py_out = str(Path(tmp) / "py.json")
            ts_out = str(Path(tmp) / "ts.json")
            if emit_python(py_out, target_args):
                failed.append("python")
            if emit_typescript(ts_out, target_args):
                failed.append("typescript")
            # A runner whose target raised wrote no emit and said why.
            if not (Path(py_out).exists() and Path(ts_out).exists()):
                sys.exit(2)
            py = load(py_out)
            ts = load(ts_out)

    mismatches = 0
    for key in sorted(py.keys() | ts.keys()):
        target, case_id = key
        a, b = py.get(key), ts.get(key)
        if a is None:
            print(f"ONLY-TS  [{target}] {case_id}")
            mismatches += 1
            continue
        if b is None:
            print(f"ONLY-PY  [{target}] {case_id}")
            mismatches += 1
            continue
        diffs = diff_row(a, b)
        if diffs:
            mismatches += 1
            print(f"DIFF [{target}] {case_id}: {'; '.join(diffs)}")

    compared = len(py.keys() & ts.keys())
    print(
        f"\n{compared} case/target pairs compared, {mismatches} mismatch(es)"
        f" across targets: {', '.join(targets)}"
    )
    # Both emit runs skip a target whose service never came up, and a run
    # that compared nothing agrees with itself trivially. Zero pairs is a
    # broken run, never a clean one.
    if compared == 0:
        print("no case/target pairs compared", file=sys.stderr)
        sys.exit(2)
    # Each runner checks its own goldens too, and a case that misses its
    # golden the same way on both hosts agrees with itself here.
    if failed:
        print(f"battery failed on: {', '.join(failed)}", file=sys.stderr)
    if mismatches or failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
