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
import subprocess

from dotenv import load_dotenv

from mirage import Mount, MountMode, Workspace
from mirage.resource.linear import LinearConfig, LinearResource

load_dotenv(".env.development")

config = LinearConfig(api_key=os.environ["LINEAR_API_KEY"])
resource = LinearResource(config=config)

with Workspace({"/linear/": Mount(resource, mode=MountMode.READ,
                                  fuse=True)}) as ws:
    mp = ws.fuse_mountpoint

    print(f"=== FUSE MODE: mounted at {mp} ===\n")

    print("--- os.listdir() teams ---")
    teams = os.listdir(f"{mp}/teams")
    for t in teams[:5]:
        print(f"  {t}")

    if teams:
        team = teams[0]
        team_path = f"{mp}/teams/{team}"

        print(f"\n--- os.listdir() {team} ---")
        contents = os.listdir(team_path)
        for c in contents:
            print(f"  {c}")

        # Linear cannot report a file size before fetching, so an unopened
        # team.json stats as 0 bytes; any open (cat/wc/cp) hydrates it, and
        # stat then reports the real size (see docs/python/setup/fuse.mdx).
        team_json = f"{team_path}/team.json"
        print("\n--- size-unknown semantics on team.json ---")
        print(f"  stat before open: {os.stat(team_json).st_size} bytes")
        wc = subprocess.run(["wc", "-c", team_json],
                            capture_output=True,
                            text=True)
        print(f"  wc -c           : {wc.stdout.split()[0]} bytes")
        print(f"  stat after read : {os.stat(team_json).st_size} bytes")

        print("\n--- open() team.json ---")
        with open(f"{team_path}/team.json") as f:
            data = json.loads(f.read())
            name = data.get("team_name", "?")
            key = data.get("team_key", "?")
            print(f"  {key}: {name}")

    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> Open another terminal and run:")
    print(f">>>   ls {mp}/teams/")
    print(">>> Press Enter to unmount and exit...")
    input()

    records = ws.ops.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, {total} bytes")
