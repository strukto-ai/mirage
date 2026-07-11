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
from mirage.resource.github_ci import GitHubCIConfig, GitHubCIResource

load_dotenv(".env.development")

config = GitHubCIConfig(
    token=os.environ["GITHUB_TOKEN"],
    owner="strukto-ai",
    repo="mirage",
    max_runs=300,
)
resource = GitHubCIResource(config=config)


async def main():
    ws = Workspace({"/ci": resource}, mode=MountMode.READ)

    print("=== not-found errors show the full virtual path ===")
    for cmd in ("cat /ci/__nf_missing__.txt", "head /ci/__nf_missing__.txt",
                "stat /ci/__nf_missing__.txt"):
        result = await ws.execute(cmd)
        print(f"$ {cmd}")
        print(f"  exit={result.exit_code}  "
              f"{(await result.stderr_str()).strip()}")

    # ── discover structure ────────────────────────────
    print("=== ls /ci/ (root) ===")
    r = await ws.execute("ls /ci/")
    print(await r.stdout_str())

    # ── list workflows ────────────────────────────────
    print("=== ls /ci/workflows/ ===")
    r = await ws.execute("ls /ci/workflows/")
    print(await r.stdout_str())

    workflows = (await r.stdout_str()).strip().splitlines()
    if not workflows or not workflows[0]:
        print("no workflows found")
        return

    wf_name = workflows[0].strip()

    # ── read workflow metadata ────────────────────────
    print(f"=== cat /ci/workflows/{wf_name} ===")
    r = await ws.execute(f'cat "/ci/workflows/{wf_name}"')
    print((await r.stdout_str())[:500])

    # ── list runs ─────────────────────────────────────
    print("\n=== ls /ci/runs/ ===")
    r = await ws.execute("ls /ci/runs/")
    print(await r.stdout_str())

    print("\n=== ls -l /ci/runs/ (mtime from updated_at) ===")
    long_runs = await ws.execute("ls -l /ci/runs/ | head -n 5")
    print(await long_runs.stdout_str())

    runs = (await r.stdout_str()).strip().splitlines()
    if not runs or not runs[0]:
        print("no runs found")
        return

    run_name = runs[0].strip()
    run_path = f"/ci/runs/{run_name}"

    # ── list run contents ─────────────────────────────
    print(f"=== ls {run_path}/ ===")
    r = await ws.execute(f'ls "{run_path}/"')
    print(await r.stdout_str())

    # ── read run metadata ─────────────────────────────
    print(f"=== cat {run_path}/run.json | head -n 20 ===")
    r = await ws.execute(f'cat "{run_path}/run.json" | head -n 20')
    print(await r.stdout_str())

    # ── stat on the run ───────────────────────────────
    print(f"=== stat {run_path} ===")
    r = await ws.execute(f'stat "{run_path}"')
    print(f"  {(await r.stdout_str()).strip()}")

    # ── list jobs ─────────────────────────────────────
    jobs_path = f"{run_path}/jobs"
    print(f"\n=== ls {jobs_path}/ ===")
    r = await ws.execute(f'ls "{jobs_path}/"')
    print(await r.stdout_str())

    jobs_out = (await r.stdout_str()).strip().splitlines()
    json_jobs = [j.strip() for j in jobs_out if j.strip().endswith(".json")]
    log_jobs = [j.strip() for j in jobs_out if j.strip().endswith(".log")]

    # ── read a job .json ──────────────────────────────
    if json_jobs:
        job_name = json_jobs[0]
        job_path = f"{jobs_path}/{job_name}"
        print(f"=== cat {job_name} | head -n 20 ===")
        r = await ws.execute(f'cat "{job_path}" | head -n 20')
        print(await r.stdout_str())

        print(f"=== stat {job_name} ===")
        r = await ws.execute(f'stat "{job_path}"')
        print(f"  {(await r.stdout_str()).strip()}")

    # ── read a job .log ───────────────────────────────
    if log_jobs:
        log_name = log_jobs[0]
        log_path = f"{jobs_path}/{log_name}"
        print(f"=== head -n 20 {log_name} ===")
        r = await ws.execute(f'head -n 20 "{log_path}"')
        print((await r.stdout_str())[:1000])

        print(f"\n=== tail -n 10 {log_name} ===")
        r = await ws.execute(f'tail -n 10 "{log_path}"')
        print((await r.stdout_str())[:500])

        print(f"\n=== wc -l {log_name} ===")
        r = await ws.execute(f'wc -l "{log_path}"')
        print(f"  {(await r.stdout_str()).strip()}")

    # ── annotations ───────────────────────────────────
    print(f"\n=== cat {run_path}/annotations.jsonl ===")
    r = await ws.execute(f'cat "{run_path}/annotations.jsonl"')
    out = (await r.stdout_str()).strip()
    if out:
        for line in out.splitlines()[:5]:
            print(f"  {line[:120]}")
    else:
        print("  (no annotations)")

    # ── artifacts ─────────────────────────────────────
    print(f"\n=== ls {run_path}/artifacts/ ===")
    r = await ws.execute(f'ls "{run_path}/artifacts/"')
    out = (await r.stdout_str()).strip()
    if out:
        print(out)
    else:
        print("  (no artifacts)")

    # ── tree ──────────────────────────────────────────
    print("\n=== tree -L 2 /ci/ ===")
    r = await ws.execute("tree -L 2 /ci/")
    print(await r.stdout_str())

    # ── find (scoped to a single run) ─────────────────
    print(f"=== find {run_path}/ -name '*.log' | head -n 10 ===")
    r = await ws.execute(f'find "{run_path}/" -name "*.log" | head -n 10')
    print(await r.stdout_str())

    print(f"=== find {run_path}/ -name '*.json' | head -n 10 ===")
    r = await ws.execute(f'find "{run_path}/" -name "*.json" | head -n 10')
    print(await r.stdout_str())

    # ── cd into a run ─────────────────────────────────
    print("=== pwd ===")
    r = await ws.execute("pwd")
    print(f"  {(await r.stdout_str()).strip()}")

    print(f'\n=== cd "{run_path}" ===')
    r = await ws.execute(f'cd "{run_path}"')
    print(f"  exit={r.exit_code}")

    print("\n=== pwd (after cd) ===")
    r = await ws.execute("pwd")
    print(f"  {(await r.stdout_str()).strip()}")

    print("\n=== ls (relative, in run dir) ===")
    r = await ws.execute("ls")
    print(await r.stdout_str())

    print("=== cat run.json | head -n 5 (relative) ===")
    r = await ws.execute("cat run.json | head -n 5")
    print(await r.stdout_str())

    # ── cd into jobs ──────────────────────────────────
    print('=== cd jobs ===')
    r = await ws.execute("cd jobs")
    print(f"  exit={r.exit_code}")

    print("\n=== pwd (after cd jobs) ===")
    r = await ws.execute("pwd")
    print(f"  {(await r.stdout_str()).strip()}")

    print("\n=== ls (relative, in jobs dir) ===")
    r = await ws.execute("ls")
    print(await r.stdout_str())

    if log_jobs:
        log_name = log_jobs[0]
        print(f"=== head -n 5 {log_name} (relative) ===")
        r = await ws.execute(f"head -n 5 {log_name}")
        print((await r.stdout_str())[:300])

    # ── stat on workflows ─────────────────────────────
    print("\n=== stat /ci/workflows/ ===")
    r = await ws.execute('stat "/ci/workflows/"')
    print(f"  {(await r.stdout_str()).strip()}")

    print("\n=== stat /ci/runs/ ===")
    r = await ws.execute('stat "/ci/runs/"')
    print(f"  {(await r.stdout_str()).strip()}")


if __name__ == "__main__":
    asyncio.run(main())
