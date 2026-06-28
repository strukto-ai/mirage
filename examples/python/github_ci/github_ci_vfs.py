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
import json
import os
import sys

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.github_ci import GitHubCIConfig, GitHubCIResource

load_dotenv(".env.development")

config = GitHubCIConfig(
    token=os.environ["GITHUB_TOKEN"],
    owner="strukto-ai",
    repo="mirage-internal",
    max_runs=300,
)
resource = GitHubCIResource(config=config)


async def main():
    with Workspace({"/ci/": resource}, mode=MountMode.READ) as ws:
        vos = sys.modules["os"]
        print("=== VFS MODE: open() reads from GitHub CI transparently ===\n")

        print("--- os.listdir() root ---")
        entries = vos.listdir("/ci")
        for e in entries:
            print(f"  {e}")

        print("\n--- os.listdir() workflows ---")
        workflows = vos.listdir("/ci/workflows")
        for wf in workflows[:10]:
            print(f"  {wf}")

        if workflows:
            wf_path = f"/ci/workflows/{workflows[0]}"
            print(f"\n--- open() + read {wf_path} ---")
            with open(wf_path) as f:
                data = json.loads(f.read())
            print(f"  name: {data.get('name')}")
            print(f"  path: {data.get('path')}")
            print(f"  state: {data.get('state')}")

        print("\n--- os.listdir() runs ---")
        runs = vos.listdir("/ci/runs")
        for r in runs[:5]:
            print(f"  {r}")
        if len(runs) > 5:
            print(f"  ... ({len(runs)} total)")

        if runs:
            run_path = f"/ci/runs/{runs[0]}"
            print(f"\n--- os.listdir() {run_path} ---")
            contents = vos.listdir(run_path)
            for c in contents:
                print(f"  {c}")

            if "run.json" in contents:
                print("\n--- open() + read run.json ---")
                with open(f"{run_path}/run.json") as f:
                    data = json.loads(f.read())
                print(f"  status: {data.get('status')}")
                print(f"  conclusion: {data.get('conclusion')}")
                print(f"  event: {data.get('event')}")
                print(f"  branch: {data.get('head_branch')}")

            if "jobs" in contents:
                jobs_path = f"{run_path}/jobs"
                print("\n--- os.listdir() jobs ---")
                jobs = vos.listdir(jobs_path)
                for j in jobs[:10]:
                    print(f"  {j}")

                json_jobs = [j for j in jobs if j.endswith(".json")]
                log_jobs = [j for j in jobs if j.endswith(".log")]

                if json_jobs:
                    print("\n--- open() + read job .json ---")
                    with open(f"{jobs_path}/{json_jobs[0]}") as f:
                        data = json.loads(f.read())
                    print(f"  name: {data.get('name')}")
                    print(f"  status: {data.get('status')}")
                    print(f"  conclusion: {data.get('conclusion')}")
                    steps = data.get("steps", [])
                    print(f"  steps: {len(steps)}")
                    for s in steps[:3]:
                        print(f"    {s.get('number')}. {s.get('name')}"
                              f" -> {s.get('conclusion')}")

                if log_jobs:
                    print("\n--- open() + read job .log (first 10 lines) ---")
                    with open(f"{jobs_path}/{log_jobs[0]}") as f:
                        for i, line in enumerate(f):
                            if i >= 10:
                                print("  ...")
                                break
                            print(f"  {line.rstrip()[:120]}")

        print("\n--- bash history ---")
        with open("/.bash_history") as f:
            for i, line in enumerate(f):
                if i >= 6:
                    break
                print(f"  {line.rstrip()[:120]}")

        records = ws.ops.records
        total = sum(r.bytes for r in records)
        print(f"\nStats: {len(records)} ops, {total} bytes transferred")


asyncio.run(main())
