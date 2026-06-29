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

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.linear import LinearConfig, LinearResource

load_dotenv(".env.development")

config = LinearConfig(api_key=os.environ["LINEAR_API_KEY"])
resource = LinearResource(config=config)


async def main() -> None:
    ws = Workspace({"/linear": resource}, mode=MountMode.READ)

    print("=== not-found errors show the full virtual path ===")
    for cmd in ("cat /linear/__nf_missing__.txt",
                "head /linear/__nf_missing__.txt",
                "stat /linear/__nf_missing__.txt"):
        result = await ws.execute(cmd)
        print(f"$ {cmd}")
        print(f"  exit={result.exit_code}  "
              f"{(await result.stderr_str()).strip()}")

    print("=== ls /linear/teams/ ===")
    result = await ws.execute("ls /linear/teams/")
    print(await result.stdout_str())

    print("=== ls -l /linear/teams/ (mtime from updatedAt) ===")
    long_result = await ws.execute("ls -l /linear/teams/")
    print(await long_result.stdout_str())

    first_team = (await result.stdout_str()).strip().splitlines()[0] if (
        await result.stdout_str()).strip() else ""
    if not first_team:
        print("No teams available")
        return

    print(f"=== cat /linear/teams/{first_team}/team.json ===")
    result = await ws.execute(f"cat /linear/teams/{first_team}/team.json")
    print(await result.stdout_str())

    print(f"=== ls /linear/teams/{first_team}/issues/ ===")
    issue_result = await ws.execute(f"ls /linear/teams/{first_team}/issues/")
    print(await issue_result.stdout_str())

    print(f"=== ls /linear/teams/{first_team}/projects/ ===")
    project_result = await ws.execute(
        f"ls /linear/teams/{first_team}/projects/")
    print(await project_result.stdout_str())

    project_names = (await project_result.stdout_str()).strip().splitlines()
    mirage_project = next(
        (name for name in project_names if name.startswith("Mirage__")),
        "",
    )
    if mirage_project:
        print(
            f"=== cat /linear/teams/{first_team}/projects/{mirage_project} ==="
        )
        result = await ws.execute(
            f"cat /linear/teams/{first_team}/projects/{mirage_project}")
        print(await result.stdout_str())

        project_payload = json.loads(await result.stdout_str())
        print("=== issues in Mirage project ===")
        for issue in project_payload.get("issues", []):
            print(f"{issue['issue_key']}: "
                  f"{issue['title']} "
                  f"[{issue['state_name']}]")
    else:
        print("Mirage project not found in first team")

    first_issue = (await
                   issue_result.stdout_str()).strip().splitlines()[0] if (
                       await issue_result.stdout_str()).strip() else ""
    if not first_issue:
        print("No issues available in first team")
        return

    issue_path = f"/linear/teams/{first_team}/issues/{first_issue}"

    print("=== cat issue.json ===")
    result = await ws.execute(f"cat {issue_path}/issue.json")
    print(await result.stdout_str())

    print("=== head -n 3 comments.jsonl ===")
    result = await ws.execute(f"head -n 3 {issue_path}/comments.jsonl")
    print(await result.stdout_str())

    print("=== tail -n 1 comments.jsonl ===")
    result = await ws.execute(f"tail -n 1 {issue_path}/comments.jsonl")
    print(await result.stdout_str())

    print("=== wc -l comments.jsonl ===")
    result = await ws.execute(f"wc -l {issue_path}/comments.jsonl")
    print(await result.stdout_str())

    print("=== stat issue.json ===")
    result = await ws.execute(f"stat {issue_path}/issue.json")
    print(await result.stdout_str())

    print("=== jq .title issue.json ===")
    result = await ws.execute(f'jq ".title" {issue_path}/issue.json')
    print(await result.stdout_str())

    print("=== jq .state_name issue.json ===")
    result = await ws.execute(f'jq ".state_name" {issue_path}/issue.json')
    print(await result.stdout_str())

    print("=== tree -L 1 /linear/ ===")
    result = await ws.execute("tree -L 1 /linear/")
    print(await result.stdout_str())

    print(f"=== tree -L 1 teams/{first_team} ===")
    result = await ws.execute(f"tree -L 1 /linear/teams/{first_team}/")
    print(await result.stdout_str())

    print("=== find issues -name '*.json' ===")
    result = await ws.execute(
        f'find /linear/teams/{first_team}/issues/ -name "*.json"'
        " | head -n 5")
    print(await result.stdout_str())

    print("=== find teams -type d (directory filter) ===")
    result = await ws.execute(f"find /linear/teams/{first_team}/ -type d"
                              " | head -n 5")
    print(await result.stdout_str())

    print(f"=== du -s teams/{first_team} (walk fallback) ===")
    result = await ws.execute(f"du -s /linear/teams/{first_team}/")
    print(await result.stdout_str())

    print("=== grep Mirage issue.json ===")
    result = await ws.execute(f'grep Mirage {issue_path}/issue.json')
    print(await result.stdout_str())

    print("=== rg Backlog team.json ===")
    result = await ws.execute(
        f"rg Backlog /linear/teams/{first_team}/team.json")
    print(await result.stdout_str())

    print("=== basename ===")
    result = await ws.execute(f"basename {issue_path}/issue.json")
    print(await result.stdout_str())

    print("=== dirname ===")
    result = await ws.execute(f"dirname {issue_path}/issue.json")
    print(await result.stdout_str())

    # ── glob expansion (exercises resolve_glob → readdir) ──
    issues_dir = f"/linear/teams/{first_team}/issues"
    print(f"=== echo {issues_dir}/* (glob) ===")
    r = await ws.execute(f"echo {issues_dir}/*")
    out = (await r.stdout_str()).strip()
    print(f"  {out[:200]}")

    print(f"\n=== for f in {issues_dir}/* (glob loop) ===")
    r = await ws.execute(f"for f in {issues_dir}/*; do echo found:$f; done"
                         " | head -n 3")
    out = (await r.stdout_str()).strip()
    for line in out.splitlines():
        print(f"  {line[:120]}")


if __name__ == "__main__":
    asyncio.run(main())
