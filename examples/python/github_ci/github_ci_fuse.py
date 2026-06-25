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

from dotenv import load_dotenv

from mirage import Mount, MountMode, Workspace
from mirage.resource.github_ci import GitHubCIConfig, GitHubCIResource

load_dotenv(".env.development")

config = GitHubCIConfig(
    token=os.environ["GITHUB_TOKEN"],
    owner="strukto-ai",
    repo="mirage-internal",
    max_runs=300,
)
resource = GitHubCIResource(config=config)

with Workspace({"/ci/": Mount(resource, mode=MountMode.READ,
                              fuse=True)}) as ws:
    mp = ws.fuse_mountpoint

    print(f"=== FUSE MODE: mounted at {mp} ===\n")

    # ── list root ────────────────────────────────
    print("--- os.listdir() root ---")
    entries = os.listdir(mp)
    for e in entries:
        print(f"  {e}")

    # ── list workflows ───────────────────────────
    print("\n--- os.listdir() workflows ---")
    workflows = os.listdir(f"{mp}/workflows")
    for wf in workflows[:10]:
        print(f"  {wf}")

    if workflows:
        wf_path = f"{mp}/workflows/{workflows[0]}"
        print(f"\n--- open() + read {workflows[0]} ---")
        with open(wf_path) as f:
            data = json.loads(f.read())
        print(f"  name: {data.get('name')}")
        print(f"  state: {data.get('state')}")

    # ── list runs ────────────────────────────────
    print("\n--- os.listdir() runs ---")
    runs = os.listdir(f"{mp}/runs")
    for r in runs[:5]:
        print(f"  {r}")
    if len(runs) > 5:
        print(f"  ... ({len(runs)} total)")

    if runs:
        run = runs[0]
        run_dir = f"{mp}/runs/{run}"

        # ── list run contents ────────────────────
        print(f"\n--- os.listdir() {run} ---")
        contents = os.listdir(run_dir)
        for c in contents:
            print(f"  {c}")

        # ── read run.json ────────────────────────
        run_json = f"{run_dir}/run.json"
        if os.path.exists(run_json):
            print("\n--- open() + read run.json ---")
            with open(run_json) as f:
                data = json.loads(f.read())
            print(f"  status: {data.get('status')}")
            print(f"  conclusion: {data.get('conclusion')}")
            print(f"  event: {data.get('event')}")

        # ── list and read jobs ───────────────────
        jobs_dir = f"{run_dir}/jobs"
        if os.path.isdir(jobs_dir):
            print("\n--- os.listdir() jobs ---")
            jobs = os.listdir(jobs_dir)
            for j in jobs:
                print(f"  {j}")

            log_files = [j for j in jobs if j.endswith(".log")]
            if log_files:
                log_path = f"{jobs_dir}/{log_files[0]}"
                print(
                    f"\n--- open() + read {log_files[0]} (first 10 lines) ---")
                with open(log_path) as f:
                    for i, line in enumerate(f):
                        if i >= 10:
                            print("  ...")
                            break
                        print(f"  {line.rstrip()[:120]}")

        # ── list artifacts ───────────────────────
        artifacts_dir = f"{run_dir}/artifacts"
        if os.path.isdir(artifacts_dir):
            print("\n--- os.listdir() artifacts ---")
            artifacts = os.listdir(artifacts_dir)
            for a in artifacts:
                print(f"  {a}")
            if not artifacts:
                print("  (none)")

    # ── interactive ──────────────────────────────
    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> Open another terminal and run:")
    print(f">>>   ls {mp}/")
    print(f">>>   ls {mp}/runs/")
    print(f">>>   cat {mp}/runs/<run>/run.json")
    print(">>> Press Enter to unmount and exit...")
    input()

    records = ws.ops.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, {total} bytes")
