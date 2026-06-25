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

import os

from dotenv import load_dotenv

from mirage import Mount, MountMode, Workspace
from mirage.resource.github import GitHubConfig, GitHubResource

load_dotenv(".env.development")

config = GitHubConfig(token=os.environ["GITHUB_TOKEN"])

resource = GitHubResource(
    config=config,
    owner="strukto-ai",
    repo="mirage-internal",
    ref="main",
)

with Workspace({"/github/": Mount(resource, mode=MountMode.READ,
                                  fuse=True)}) as ws:
    mp = ws.fuse_mountpoint

    print(f"=== FUSE MODE: mounted at {mp} ===\n")

    print("--- os.listdir() root ---")
    entries = os.listdir(mp)
    for e in entries[:10]:
        print(f"  {e}")
    if len(entries) > 10:
        print(f"  ... ({len(entries)} total)")

    print("\n--- os.listdir() python/mirage/ ---")
    core = os.listdir(f"{mp}/python/mirage")
    for c in core[:10]:
        print(f"  {c}")

    print("\n--- os.listdir() python/mirage/core/ ---")
    core_dirs = os.listdir(f"{mp}/python/mirage/core")
    for d in core_dirs[:10]:
        print(f"  {d}")
    if len(core_dirs) > 10:
        print(f"  ... ({len(core_dirs)} total)")

    print("\n--- open() + read python/pyproject.toml (first 5 lines) ---")
    with open(f"{mp}/python/pyproject.toml") as f:
        for i, line in enumerate(f):
            if i >= 5:
                break
            print(f"  {line.rstrip()}")

    print("\n--- open() + read python/mirage/types.py (first 5 lines) ---")
    with open(f"{mp}/python/mirage/types.py") as f:
        for i, line in enumerate(f):
            if i >= 5:
                break
            print(f"  {line.rstrip()}")

    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> Open another terminal and run:")
    print(f">>>   ls {mp}/")
    print(f">>>   cat {mp}/README.md")
    print(">>> Press Enter to unmount and exit...")
    input()

    records = ws.ops.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, {total} bytes")
