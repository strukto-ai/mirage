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
import time
from dataclasses import dataclass, field
from pathlib import Path

from mirage.types import FileStat, PathSpec

CASE_DIRS = ("unix", "bash", "crossmount", "runtime", "resources", "cli")


def integ_root() -> Path:
    return Path(__file__).resolve().parents[2]


def load_targets(root: Path) -> dict:
    data = json.loads((root / "targets.json").read_text())
    return {t["id"]: t for t in data["targets"]}


def discover_case_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for name in CASE_DIRS:
        files.extend(sorted((root / name).rglob("*.json")))
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


def _check_field(st: FileStat, name: str) -> str:
    if name == "mode":
        value = oct(st.mode)[2:] if st.mode is not None else "-"
    elif name == "uid":
        value = str(st.uid) if st.uid is not None else "-"
    elif name == "gid":
        value = str(st.gid) if st.gid is not None else "-"
    else:
        # First 19 chars ("2026-01-02T15:30:00") so the Z vs +00:00 suffix
        # never reaches the comparison.
        value = st.modified[:19] if st.modified else "-"
    return f"{name}={value}"


async def stat_check(ws, check: dict) -> str:
    try:
        st, _ = await ws.dispatch("stat",
                                  PathSpec.from_str_path(check["stat"]))
    except FileNotFoundError:
        return "absent\n"
    line = " ".join(_check_field(st, name) for name in check["fields"])
    return line + "\n"


def provision_line(result) -> str:
    return (f"net={result.network_read} write={result.network_write} "
            f"cache={result.cache_read} ops={result.read_ops} "
            f"hits={result.cache_hits} precision={result.precision.value}")


async def run_case(ws, case: dict) -> tuple[int, str, str, float]:
    if case.get("clear_cache"):
        # A full clear means the file cache AND every mount's index cache:
        # remote listings live in the per-resource index, and a listing
        # populated by an earlier case must not leak into this one.
        # Resources without an index cache have nothing to clear.
        await ws.cache.clear()
        for mount in ws.mounts():
            store = getattr(mount.resource, "index", None)
            if store is not None:
                await store.clear()
    start = time.monotonic()
    if case.get("provision"):
        plan = await ws.execute(case["command"], provision=True)
        return 0, provision_line(plan) + "\n", "", time.monotonic() - start
    result = await ws.execute(case["command"])
    elapsed = time.monotonic() - start
    out = await result.stdout_str()
    err = await result.stderr_str()
    if case.get("check") is not None:
        out = await stat_check(ws, case["check"])
    return result.exit_code, out, err, elapsed


async def run_scenario(read_ws, mutate, steps: list[dict]) -> tuple[int, str]:
    outs: list[str] = []
    exit_code = 0
    for step in steps:
        if "mutate" in step:
            spec = step["mutate"]
            await mutate(spec["path"], spec["content"].encode())
            continue
        result = await read_ws.execute(step["command"])
        outs.append(await result.stdout_str())
        exit_code = result.exit_code
    return exit_code, "".join(outs)


def compare(case: dict, exit_code: int, out: str, err: str,
            elapsed: float) -> list[str]:
    expect = case["expect"]
    diffs: list[str] = []
    if exit_code != expect["exit"]:
        diffs.append(f"exit: expected {expect['exit']}, got {exit_code}")
    if out != expect["stdout"]:
        diffs.append(f"stdout: expected {expect['stdout']!r}, got {out!r}")
    if err.rstrip("\n") != expect["stderr"].rstrip("\n"):
        diffs.append(f"stderr: expected {expect['stderr']!r}, got {err!r}")
    bounds = expect.get("elapsed")
    if bounds is not None and not bounds["min"] <= elapsed <= bounds["max"]:
        diffs.append(f"elapsed: expected [{bounds['min']}, {bounds['max']}]"
                     f", got {elapsed:.3f}")
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
