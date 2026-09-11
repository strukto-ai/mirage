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

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.gdrive import GoogleDriveConfig, GoogleDriveResource
from mirage.resource.github import GitHubConfig, GitHubResource
from mirage.resource.s3 import S3Config, S3Resource

load_dotenv(".env.development")

s3_config = S3Config(
    bucket=os.environ["AWS_S3_BUCKET"],
    region=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
    aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
)
gdrive_config = GoogleDriveConfig(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)
github_config = GitHubConfig(token=os.environ["GITHUB_TOKEN"])

# GitHub fetches the repo tree on first read, so building the mount is an
# ordinary call like every other one here.
github_resource = GitHubResource(github_config, owner="strukto", repo="mirage")

ws = Workspace(
    {
        "/s3/": S3Resource(s3_config),
        "/gdrive/": GoogleDriveResource(gdrive_config),
        "/github/": github_resource,
    },
    mode=MountMode.READ,
)


def ops_summary() -> str:
    records = ws.fs.records
    total = sum(r.bytes for r in records)
    return f"{len(records)} ops, {total} bytes transferred"


async def main():
    # ── prime gdrive cache ──
    await ws.execute("ls /gdrive/")
    await ws.execute("ls /gdrive/mirage/")

    # ── plan: directory scans across resources ──
    print("=== PLAN: DIRECTORY SCANS ===\n")

    dr = await ws.execute("grep mirage /s3/data/example.jsonl", provision=True)
    print(f"s3 single file: network_read={dr.network_read}")

    dr = await ws.execute("grep mirage /gdrive/mirage/example.jsonl",
                          provision=True)
    print(f"gdrive single file: network_read={dr.network_read}")

    dr = await ws.execute("rg import /github/mirage/commands/registry.py",
                          provision=True)
    print(f"github single file: network_read={dr.network_read}")

    print(f"\nStats after plans (should be 0): {ops_summary()}")

    # ── S3: grep on single file vs directory ──
    print("\n=== S3: SINGLE FILE vs DIRECTORY ===\n")

    r = await ws.execute("grep mirage /s3/data/example.jsonl | wc -l")
    print(f"single file: {(await r.stdout_str()).strip()} matches")

    r = await ws.execute("rg -l mirage /s3/data/")
    files = (await r.stdout_str()).strip().splitlines()
    print(f"directory rg -l: {len(files)} files match")
    print(f"Stats: {ops_summary()}")

    # ── Google Drive: grep with streaming ──
    print("\n=== GDRIVE: GREP WITH STREAMING ===\n")

    r = await ws.execute(
        "grep queue-operation /gdrive/mirage/example.jsonl | wc -l")
    print(f"grep | wc: {(await r.stdout_str()).strip()} matches")

    r = await ws.execute("grep queue-operation /gdrive/mirage/example.jsonl"
                         " | head -n 3")
    lines = (await r.stdout_str()).strip().splitlines()
    print(f"grep | head -n 3: {len(lines)} lines")

    print(f"Stats: {ops_summary()}")

    # ── GitHub: rg with search_code optimization ──
    print("\n=== GITHUB: RG (search_code optimization) ===\n")

    r = await ws.execute(
        "rg -l workspace /github/mirage/workspace/workspace.py")
    files = (await r.stdout_str()).strip().splitlines()
    print(f"rg -l workspace (single file): {len(files)} files")
    if files:
        print(f"  {files[0]}")

    r = await ws.execute("rg -l import /github/mirage/")
    if r.stderr:
        print(f"rg on large dir: {r.stderr.decode().strip()}")
    else:
        files = (await r.stdout_str()).strip().splitlines()
        print(f"rg -l import (large dir): {len(files)} files")

    r = await ws.execute("grep -c def /github/mirage/commands/registry.py")
    print(f"grep -c def registry.py: {(await r.stdout_str()).strip()}")

    print(f"Stats: {ops_summary()}")

    # ── cross-resource consistency ──
    print("\n=== CROSS-RESOURCE: SAME DATA ===\n")

    r1 = await ws.execute("wc -l /s3/data/example.jsonl")
    r2 = await ws.execute("wc -l /gdrive/mirage/example.jsonl")
    print(f"s3 wc -l: {(await r1.stdout_str()).strip()}")
    print(f"gdrive wc -l: {(await r2.stdout_str()).strip()}")

    r1 = await ws.execute("grep -c queue-operation /s3/data/example.jsonl")
    r2 = await ws.execute(
        "grep -c queue-operation /gdrive/mirage/example.jsonl")
    print(f"s3 grep -c queue-operation: {(await r1.stdout_str()).strip()}")
    print(f"gdrive grep -c queue-operation: {(await r2.stdout_str()).strip()}")

    # ── bash history ──
    print("\n=== BASH HISTORY ===\n")

    print(f"Total ops: {ops_summary()}")
    print(f"Commands recorded: {len(await ws.history())}")

    r = await ws.execute("tail -n 6 /.bash_history")
    for line in (await r.stdout_str()).strip().splitlines():
        print(f"  {line[:120]}")


asyncio.run(main())
