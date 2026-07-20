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
SHARED_TARGETS = ["ram", "disk", "redis"]
S3_TARGETS = ["s3", "s3-prefix", "object-storage-prefix"]
SSH_TARGETS = ["ssh"]
GDRIVE_TARGETS = ["gdrive", "gdrive-folder", "gdrive-shared", "gapps", "gmail"]


def load(path: str) -> dict[tuple[str, str], dict]:
    rows = json.loads(Path(path).read_text())
    return {(r["target"], r["id"]): r for r in rows}


def emit_python(out: str, target_args: list[str]) -> None:
    subprocess.run([
        sys.executable,
        str(INTEG / "runners" / "python" / "main.py"), "--emit", out,
        *target_args
    ],
                   check=True)


def emit_typescript(out: str, target_args: list[str]) -> None:
    subprocess.run([
        "pnpm", "exec", "tsx", "runners/typescript/main.ts", "--emit", out,
        *target_args
    ],
                   cwd=INTEG,
                   check=True)


def diff_row(a: dict, b: dict) -> list[str]:
    diffs: list[str] = []
    if a["exit"] != b["exit"]:
        diffs.append(f"exit py={a['exit']} ts={b['exit']}")
    if a["stdout"] != b["stdout"]:
        diffs.append(f"stdout py={a['stdout']!r} ts={b['stdout']!r}")
    if a["stderr"].rstrip("\n") != b["stderr"].rstrip("\n"):
        diffs.append(f"stderr py={a['stderr']!r} ts={b['stderr']!r}")
    return diffs


def main() -> None:
    default_targets = list(SHARED_TARGETS)
    if os.environ.get("S3_ENDPOINT"):
        default_targets += S3_TARGETS
    if os.environ.get("SSH_HOST"):
        default_targets += SSH_TARGETS
    if os.environ.get("GWS_URL"):
        default_targets += GDRIVE_TARGETS
    targets = sys.argv[1:] or default_targets
    target_args: list[str] = []
    for t in targets:
        target_args += ["--target", t]

    with tempfile.TemporaryDirectory() as tmp:
        py_out = str(Path(tmp) / "py.json")
        ts_out = str(Path(tmp) / "ts.json")
        emit_python(py_out, target_args)
        emit_typescript(ts_out, target_args)
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
    print(f"\n{compared} case/target pairs compared, {mismatches} mismatch(es)"
          f" across targets: {', '.join(targets)}")
    if mismatches:
        sys.exit(1)


if __name__ == "__main__":
    main()
