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
import os
from pathlib import Path

from mirage import MountMode, Workspace
from mirage.resource.nextcloud import NextcloudConfig, NextcloudResource
from mirage.types import CommandSafeguard

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SEED_OBJECTS = [
    "example.jsonl", "example.json", "example.parquet", "example.orc",
    "example.feather"
]
URL = os.environ.get(
    "NEXTCLOUD_URL",
    "http://localhost:8080/remote.php/dav/files/admin/",
)
USERNAME = os.environ.get("NEXTCLOUD_USERNAME", "admin")
PASSWORD = os.environ.get("NEXTCLOUD_PASSWORD", "admin123")
MOUNT = "/nc"

# Read-only, deterministic commands mirroring integ/s3.py PER_MOUNT_CASES so
# Nextcloud exercises the same shell-command surface as the object stores.
# {m} is the mount root (/nc). The root `ls`/`tree` also list Nextcloud's
# default sample files; check_lines.sh matches substrings, so those extra
# entries are tolerated and only the seeded `data/` content is asserted.
PER_MOUNT_CASES: list[tuple[str, str]] = [
    ("ls", "ls {m}/"),
    ("ls_data", "ls {m}/data/"),
    ("tree", "tree {m}/data/"),
    ("stat", "stat -c '%s %n' {m}/data/example.json"),
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
    ("file_parquet", "file {m}/data/example.parquet"),
    ("file_orc", "file {m}/data/example.orc"),
    ("file_feather", "file {m}/data/example.feather"),
    ("du_multi", "du {m}/data/example.json {m}/data/example.jsonl"),
    ("file_multi", "file {m}/data/example.json {m}/data/example.jsonl"),

    # ----- safeguard: per-mount cap on cat (set to 20 lines below) -----
    ("safeguard_cat_truncates", "cat {m}/data/example.jsonl"),
    ("safeguard_cat_pipe_uncapped", "cat {m}/data/example.jsonl | wc -l"),
]

# Streaming byte accounting mirroring integ/s3.py STREAMING_CASES: clear the
# cache, run, and report lines + first line. Early-exit commands transfer far
# less than the full object. Byte counts are backend-specific so they are not
# asserted; the line counts and first-line content are deterministic.
STREAMING_CASES: list[tuple[str, str]] = [
    ("head_c100", "head -c 100 {m}/data/example.jsonl"),
    ("head_n1", "head -n 1 {m}/data/example.jsonl"),
    ("grep_m1", "grep -m 1 mirage {m}/data/example.jsonl"),
    ("cat_wc_full", "cat {m}/data/example.jsonl | wc -l"),
]


async def _seed(ws: Workspace) -> None:
    await ws.execute(f"rm -rf {MOUNT}/data")
    await ws.execute(f"mkdir -p {MOUNT}/data")
    for obj in SEED_OBJECTS:
        await ws.ops.write(f"{MOUNT}/data/{obj}",
                           (DATA_DIR / obj).read_bytes())


async def _run(ws: Workspace, name: str, cmd: str) -> None:
    result = await ws.execute(cmd)
    out = await result.stdout_str()
    print(f"=== {name} ===")
    print(out, end="" if out.endswith("\n") else "\n")
    if "safeguard_" in name:
        err = await result.stderr_str()
        if err:
            print(err, end="" if err.endswith("\n") else "\n")


async def _measure(ws: Workspace, name: str, cmd: str) -> None:
    await ws.cache.clear()
    result = await ws.execute(cmd)
    out = await result.stdout_str()
    lines = out.strip().splitlines()
    first = lines[0][:48] if lines else ""
    print(f"=== {name} ===")
    print(f"lines={len(lines)} out0={first!r}")


def _set_cat_safeguard(ws: Workspace, max_lines: int) -> None:
    sg = CommandSafeguard(max_lines=max_lines)
    mounts = list(ws._registry._mounts)
    if ws._registry.default_mount is not None:
        mounts.append(ws._registry.default_mount)
    for m in mounts:
        m.command_safeguards["cat"] = sg


async def main() -> None:
    resource = NextcloudResource(
        NextcloudConfig(url=URL, username=USERNAME, password=PASSWORD))
    ws = Workspace({MOUNT: resource}, mode=MountMode.WRITE)
    await _seed(ws)
    _set_cat_safeguard(ws, max_lines=20)
    for name, tmpl in PER_MOUNT_CASES:
        await _run(ws, name, tmpl.format(m=MOUNT))
    for name, tmpl in STREAMING_CASES:
        await _measure(ws, f"stream:{name}", tmpl.format(m=MOUNT))


if __name__ == "__main__":
    asyncio.run(main())
