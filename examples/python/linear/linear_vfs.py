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


async def main():
    with Workspace({"/linear/": resource}, mode=MountMode.READ) as ws:
        print("=== VFS MODE ===\n")

        print("--- os.listdir() root ---")
        entries = os.listdir("/linear")
        for e in entries:
            print(f"  {e}")

        print("\n--- os.listdir() teams ---")
        teams = os.listdir("/linear/teams")
        for t in teams[:5]:
            print(f"  {t}")

        if teams:
            team = teams[0]
            team_path = f"/linear/teams/{team}"

            print(f"\n--- os.listdir() {team} ---")
            contents = os.listdir(team_path)
            for c in contents:
                print(f"  {c}")

            print("\n--- open() team.json ---")
            with open(f"{team_path}/team.json") as f:
                data = json.loads(f.read())
                print(f"  name: {data.get('team_name')}")
                print(f"  key: {data.get('team_key')}")

            issues_path = f"{team_path}/issues"
            if os.path.isdir(issues_path):
                issues = os.listdir(issues_path)
                print(f"\n--- os.listdir() issues ({len(issues)}) ---")
                for i in issues[:5]:
                    print(f"  {i}")

                if issues:
                    issue_dir = f"{issues_path}/{issues[0]}"
                    print("\n--- open() issue.json ---")
                    with open(f"{issue_dir}/issue.json") as f:
                        data = json.loads(f.read())
                        print(f"  key: {data.get('issue_key')}")
                        print(f"  title: {data.get('title')}")
                        print(f"  state: {data.get('state_name')}")

        records = ws.fs.records
        total = sum(r.bytes for r in records)
        print(f"\nStats: {len(records)} ops, {total} bytes")


asyncio.run(main())
