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

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cases import run_cache_verify_cases  # noqa: E402
from cases import run_not_found, run_provision_cache_cases  # noqa: E402
from onedrive_server import start_fake_graph  # noqa: E402

from mirage import MountMode, Workspace  # noqa: E402
from mirage.accessor.onedrive import OneDriveConfig  # noqa: E402
from mirage.commands import safeguard as _safeguard  # noqa: E402
from mirage.resource.onedrive.onedrive import OneDriveResource  # noqa: E402
from mirage.types import CommandSafeguard, ConsistencyPolicy  # noqa: E402

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SEED_OBJECTS = [
    "example.jsonl", "example.json", "example.parquet", "example.orc",
    "example.feather"
]
MOUNT = "/onedrive"

# Read-only, deterministic commands mirroring integ/s3.py: {m} is the mount
# root. OneDrive has no S3-compatible aliases, so a single mount stands in for
# the multi-bucket parity sweep, while the command coverage is identical.
PER_MOUNT_CASES: list[tuple[str, str]] = [
    ("ls", "ls {m}/"),
    ("ls_data", "ls {m}/data/"),
    ("tree", "tree {m}/"),
    ("stat", "stat -c '%s %n' {m}/data/example.json"),
    ("stat_dir", "stat {m}/data"),
    ("cat_head", "cat {m}/data/example.json | head -n 5"),
    ("head_1_jsonl", "head -n 1 {m}/data/example.jsonl"),
    ("head_3_jsonl", "head -n 3 {m}/data/example.jsonl"),
    ("tail_2_jsonl", "tail -n 2 {m}/data/example.jsonl"),
    ("wc_l_jsonl", "wc -l {m}/data/example.jsonl"),
    ("wc_c_json", "wc -c {m}/data/example.json"),
    ("grep_c_mirage", "grep -c mirage {m}/data/example.jsonl"),
    ("grep_m1_mirage", "grep -m 1 mirage {m}/data/example.jsonl"),
    ("grep_head", "grep mirage {m}/data/example.jsonl | head -n 3"),
    ("grep_queue_wc", "grep queue-operation {m}/data/example.jsonl | wc -l"),
    ("grep_rl_item", "grep -rl item {m}/data/"),
    ("rg_l_item", "rg -l item {m}/data/"),
    ("grep_rc_mirage", "grep -rc mirage {m}/data/"),
    ("grep_item_parquet", "grep item_5 {m}/data/example.parquet"),
    ("rg_item_glob_feather", "rg item_5 {m}/data/*.feather"),
    ("ls_glob_parquet", "ls {m}/data/*.parquet"),
    ("ls_file_json", "ls {m}/data/example.json"),
    ("find_json", "find {m}/ -name '*.json'"),
    ("find_type_f", "find {m}/data -type f | sort"),
    ("jq_version", "jq .metadata.version {m}/data/example.json"),
    ("jq_team_names",
     "jq '.departments[].teams[].name' {m}/data/example.json"),
    ("pipe_sort_uniq_wc", "cat {m}/data/example.jsonl"
     " | grep queue-operation | sort | uniq | wc -l"),
    ("md5_json", "md5 {m}/data/example.json"),
    ("sha256_json", "sha256sum {m}/data/example.json"),
    ("ls_l_data", "ls -l {m}/data/"),
    ("ls_l_root", "ls -l {m}/"),
    ("file_parquet", "file {m}/data/example.parquet"),
    ("file_orc", "file {m}/data/example.orc"),
    ("file_feather", "file {m}/data/example.feather"),
    ("du_multi", "du {m}/data/example.json {m}/data/example.jsonl"),
    ("file_multi", "file {m}/data/example.json {m}/data/example.jsonl"),

    # ----- safeguard: per-mount cap on cat (set to 20 lines below) -----
    ("safeguard_cat_truncates", "cat {m}/data/example.jsonl"),
    ("safeguard_cat_pipe_uncapped", "cat {m}/data/example.jsonl | wc -l"),
]

# Streaming byte accounting mirroring integ/s3.py: clear the cache, run, and
# report bytes pulled from the backend. Early-exit commands transfer far less
# than the full object. Timing is omitted so output stays deterministic.
STREAMING_CASES: list[tuple[str, str]] = [
    ("head_c100", "head -c 100 {m}/data/example.jsonl"),
    ("head_n1", "head -n 1 {m}/data/example.jsonl"),
    ("grep_m1", "grep -m 1 mirage {m}/data/example.jsonl"),
    ("cat_wc_full", "cat {m}/data/example.jsonl | wc -l"),
]

# Index fast-path accounting: from a fresh workspace (empty index), readdir
# issues one children list and populates the index, after which per-entry stat
# resolves from the index with zero item GETs. Mirrors integ/s3.py INDEX_CASES.
INDEX_CASES: list[tuple[str, str]] = [
    ("ls_l", "ls -l {m}/data/"),
    ("tree", "tree {m}/"),
]

EXIT_CODE_CASES: list[tuple[str, str]] = [
    ("grep_match", "grep -q mirage {m}/data/example.jsonl"),
    ("grep_no_match", "grep -q zzzznomatch {m}/data/example.jsonl"),
]

# Warm-read coherence: a cat warms the file cache for example.jsonl (one
# download), then each read-only command reads the same file and must be served
# from cache, leaving the download count unchanged. cat reads directly;
# grep/head/tail/wc funnel through the shared generic consumers, and head/tail
# return a lazily-drained stream, so this also pins the eager-capture fix (a
# regression would download again at drain).
WARM_READ_CASES: list[tuple[str, str]] = [
    ("warm_cat", "cat {m}/data/example.jsonl"),
    ("warm_grep", "grep mirage {m}/data/example.jsonl"),
    ("warm_head", "head -n 1 {m}/data/example.jsonl"),
    ("warm_tail", "tail -n 1 {m}/data/example.jsonl"),
    ("warm_wc", "wc -l {m}/data/example.jsonl"),
]

TIMEOUT_CASES: list[tuple[str, str]] = [
    ("timeout_sleep_fires", "sleep 2"),
]


def _seed(state) -> None:
    for obj in SEED_OBJECTS:
        state._write_file(f"data/{obj}", (DATA_DIR / obj).read_bytes())


def _build_workspace(
        consistency: ConsistencyPolicy = ConsistencyPolicy.LAZY) -> Workspace:
    resource = OneDriveResource(OneDriveConfig(access_token="integ-token"))
    return Workspace({MOUNT + "/": resource},
                     mode=MountMode.READ,
                     consistency=consistency)


async def _run(ws: Workspace, name: str, cmd: str) -> None:
    result = await ws.execute(cmd)
    out = await result.stdout_str()
    print(f"=== {name} ===")
    print(out, end="" if out.endswith("\n") else "\n")
    if "safeguard_" in name:
        err = await result.stderr_str()
        if err:
            print(err, end="" if err.endswith("\n") else "\n")


async def _run_exit(ws: Workspace, name: str, cmd: str) -> None:
    result = await ws.execute(cmd)
    err = await result.stderr_str()
    print(f"=== {name} ===")
    print(f"exit={result.exit_code}")
    if err:
        print(err, end="" if err.endswith("\n") else "\n")


def _set_cat_safeguard(ws: Workspace, max_lines: int) -> None:
    sg = CommandSafeguard(max_lines=max_lines)
    mounts = list(ws._registry._mounts)
    for m in mounts:
        m.command_safeguards["cat"] = sg


async def _measure(ws: Workspace, name: str, cmd: str) -> None:
    await ws.cache.clear()
    before = sum(rec.bytes for rec in ws.ops.records)
    result = await ws.execute(cmd)
    out = await result.stdout_str()
    net = sum(rec.bytes for rec in ws.ops.records) - before
    lines = out.strip().splitlines()
    first = lines[0][:48] if lines else ""
    print(f"=== {name} ===")
    print(f"bytes={net} lines={len(lines)} out0={first!r}")


async def _measure_calls(server, name: str, cmd: str) -> None:
    ws = _build_workspace()
    server.calls.clear()
    await ws.execute(cmd)
    children = server.calls.get("children", 0)
    items = server.calls.get("item", 0)
    print(f"=== {name} ===")
    print(f"children={children} item={items}")


async def _warm_read(server, name: str, cmd: str) -> None:
    ws = _build_workspace()
    server.calls.clear()
    await (await ws.execute(f"cat {MOUNT}/data/example.jsonl")).stdout_str()
    before = server.calls.get("download", 0)
    await (await ws.execute(cmd.format(m=MOUNT))).stdout_str()
    after = server.calls.get("download", 0)
    print(f"=== {name} ===")
    print(f"downloads_before={before} downloads_after={after} "
          f"served_from_cache={after == before}")


# Cache consistency mirroring integ/s3.py: read once (caches v1), mutate the
# object out-of-band on the fake Graph (new cTag), then read again. ALWAYS
# stats the backend and evicts the stale cache entry on every read so the
# second read returns v2; LAZY keeps serving the cached v1.
async def _run_consistency(state) -> None:
    key = "data/consistency.txt"
    for policy, label in ((ConsistencyPolicy.ALWAYS, "always"),
                          (ConsistencyPolicy.LAZY, "lazy")):
        state._write_file(key, b"v1")
        ws = _build_workspace(consistency=policy)
        first = await (
            await
            ws.execute(f"cat {MOUNT}/data/consistency.txt")).stdout_str()
        print(f"=== consistency:{label}:first ===")
        print(first, end="" if first.endswith("\n") else "\n")
        state._write_file(key, b"v2")
        second = await (
            await
            ws.execute(f"cat {MOUNT}/data/consistency.txt")).stdout_str()
        print(f"=== consistency:{label}:second ===")
        print(second, end="" if second.endswith("\n") else "\n")


async def main() -> None:
    state, server, runner = await start_fake_graph()
    try:
        _seed(state)
        ws = _build_workspace()
        _set_cat_safeguard(ws, max_lines=20)
        for name, tmpl in PER_MOUNT_CASES:
            await _run(ws, name, tmpl.format(m=MOUNT))
        for name, tmpl in STREAMING_CASES:
            await _measure(ws, f"stream:{name}", tmpl.format(m=MOUNT))
        for name, tmpl in INDEX_CASES:
            await _measure_calls(server, f"calls:{name}", tmpl.format(m=MOUNT))
        for name, tmpl in WARM_READ_CASES:
            await _warm_read(server, f"warm:{name}", tmpl)
        for name, tmpl in EXIT_CODE_CASES:
            await _run_exit(ws, f"exit:{name}", tmpl.format(m=MOUNT))
        prev_sleep = _safeguard.DEFAULT_COMMAND_SAFEGUARDS.get("sleep")
        _safeguard.DEFAULT_COMMAND_SAFEGUARDS["sleep"] = CommandSafeguard(
            timeout_seconds=0.1)
        try:
            for name, cmd in TIMEOUT_CASES:
                await _run_exit(ws, f"safeguard:{name}", cmd)
        finally:
            if prev_sleep is None:
                _safeguard.DEFAULT_COMMAND_SAFEGUARDS.pop("sleep", None)
            else:
                _safeguard.DEFAULT_COMMAND_SAFEGUARDS["sleep"] = prev_sleep
        await run_not_found(ws, MOUNT)
        # The suite workspace is read-only; the cache-flip probe seeds its
        # own files, so it gets a write-mode mount on the same fake drive.
        ws_write = Workspace(
            {
                MOUNT + "/":
                OneDriveResource(OneDriveConfig(access_token="integ-token"))
            },
            mode=MountMode.WRITE)
        await run_provision_cache_cases(ws_write, MOUNT)
        await run_cache_verify_cases(ws_write, MOUNT)
        await _run_consistency(state)
    finally:
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
