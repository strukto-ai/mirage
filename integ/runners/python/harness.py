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
from dataclasses import dataclass, field
from pathlib import Path

CASE_DIRS = ("unix", "bash", "crossmount", "runtime", "resources", "cli")


def integ_root() -> Path:
    return Path(__file__).resolve().parents[2]


def load_targets(root: Path) -> dict:
    data = json.loads((root / "targets.json").read_text())
    return {t["id"]: t for t in data["targets"]}


def discover_case_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for name in CASE_DIRS:
        files.extend(sorted((root / name).glob("*.json")))
    return files


def load_cases(root: Path) -> list[dict]:
    cases: list[dict] = []
    for path in discover_case_files(root):
        data = json.loads(path.read_text())
        for case in data["cases"]:
            case["_source"] = str(path.relative_to(root))
            cases.append(case)
    cases.sort(key=lambda c: c.get("seq", 1 << 30))
    return cases


async def seed_fixture(ws, fixture: str | None, mount_path: str,
                       root: Path) -> None:
    if not fixture:
        return
    base = root / "fixtures" / fixture
    for src in sorted(base.rglob("*")):
        if not src.is_file():
            continue
        rel = src.relative_to(base).as_posix()
        dest = f"{mount_path.rstrip('/')}/{rel}"
        parent = dest.rsplit("/", 1)[0]
        await ws.execute(f"mkdir -p {parent}")
        await ws.execute(f"tee {dest} > /dev/null", stdin=src.read_bytes())


async def run_case(ws, case: dict) -> tuple[int, str, str]:
    result = await ws.execute(case["command"])
    out = await result.stdout_str()
    err = await result.stderr_str()
    return result.exit_code, out, err


def compare(case: dict, exit_code: int, out: str, err: str) -> list[str]:
    expect = case["expect"]
    diffs: list[str] = []
    if exit_code != expect["exit"]:
        diffs.append(f"exit: expected {expect['exit']}, got {exit_code}")
    if out != expect["stdout"]:
        diffs.append(f"stdout: expected {expect['stdout']!r}, got {out!r}")
    if err.rstrip("\n") != expect["stderr"].rstrip("\n"):
        diffs.append(f"stderr: expected {expect['stderr']!r}, got {err!r}")
    return diffs


@dataclass
class Report:
    passed: int = 0
    failed: int = 0
    failures: list[str] = field(default_factory=list)

    def record(self, target: str, case_id: str, diffs: list[str]) -> None:
        if diffs:
            self.failed += 1
            joined = "; ".join(diffs)
            self.failures.append(f"[{target}] {case_id}: {joined}")
            print(f"FAIL [{target}] {case_id}: {joined}")
        else:
            self.passed += 1
            print(f"ok   [{target}] {case_id}")

    def summary(self) -> str:
        return f"{self.passed} passed, {self.failed} failed"
