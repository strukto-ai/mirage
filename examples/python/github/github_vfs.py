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
import sys

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.github import GitHubConfig, GitHubResource

load_dotenv(".env.development")

config = GitHubConfig(token=os.environ["GITHUB_TOKEN"])


async def main():
    resource = GitHubResource(
        config=config,
        owner="strukto-ai",
        repo="mirage",
        ref="main",
    )
    with Workspace({"/github/": resource}, mode=MountMode.READ) as ws:
        vos = sys.modules["os"]
        print("=== VFS MODE: open() reads from GitHub transparently ===\n")

        print("--- os.listdir() root ---")
        entries = vos.listdir("/github")
        for e in entries[:10]:
            print(f"  {e}")
        if len(entries) > 10:
            print(f"  ... ({len(entries)} total)")

        print("\n--- os.listdir() mirage/ ---")
        core = vos.listdir("/github/python/mirage")
        for c in core[:10]:
            print(f"  {c}")

        print("\n--- os.listdir() mirage/core/ ---")
        core_dirs = vos.listdir("/github/python/mirage/core")
        for d in core_dirs[:10]:
            print(f"  {d}")
        if len(core_dirs) > 10:
            print(f"  ... ({len(core_dirs)} total)")

        print("\n--- open() + read pyproject.toml (first 5 lines) ---")
        with open("/github/python/pyproject.toml") as f:
            for i, line in enumerate(f):
                if i >= 5:
                    break
                print(f"  {line.rstrip()}")

        print("\n--- open() + read mirage/types.py (first 5 lines) ---")
        with open("/github/python/mirage/types.py") as f:
            for i, line in enumerate(f):
                if i >= 5:
                    break
                print(f"  {line.rstrip()}")

        print("\n--- os.path.isdir() checks ---")
        core_isdir = vos.path.isdir("/github/python/mirage/core")
        print(f"  /github/python/mirage/core: {core_isdir}")
        is_dir = vos.path.isdir("/github/python/pyproject.toml")
        print(f"  /github/python/pyproject.toml: {is_dir}")

        print("\n--- os.path.isfile() checks ---")
        is_file = vos.path.isfile("/github/python/pyproject.toml")
        print(f"  /github/python/pyproject.toml: {is_file}")
        core_isfile = vos.path.isfile("/github/python/mirage/core")
        print(f"  /github/python/mirage/core: {core_isfile}")

        records = ws.ops.records
        total = sum(r.bytes for r in records)
        print(f"\nStats: {len(records)} ops, {total} bytes transferred")


asyncio.run(main())
