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
from mirage.resource.trello import TrelloConfig, TrelloResource

load_dotenv(".env.development")

config = TrelloConfig(
    api_key=os.environ["TRELLO_API_KEY"],
    api_token=os.environ["TRELLO_API_TOKEN"],
)
resource = TrelloResource(config=config)

with Workspace({"/trello/": Mount(resource, mode=MountMode.READ,
                                  fuse=True)}) as ws:
    mp = ws.fuse_mountpoint

    print(f"=== FUSE MODE: mounted at {mp} ===\n")

    print("--- os.listdir() workspaces ---")
    workspaces = os.listdir(f"{mp}/workspaces")
    for w in workspaces[:5]:
        print(f"  {w}")

    if workspaces:
        workspace = workspaces[0]
        ws_path = f"{mp}/workspaces/{workspace}"

        print(f"\n--- os.listdir() {workspace} ---")
        contents = os.listdir(ws_path)
        for c in contents:
            print(f"  {c}")

        print("\n--- open() workspace.json ---")
        with open(f"{ws_path}/workspace.json") as f:
            data = json.loads(f.read())
            name = data.get("workspace_name", "?")
            wid = data.get("workspace_id", "?")
            print(f"  {name}: {wid}")

    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> Open another terminal and run:")
    print(f">>>   ls {mp}/workspaces/")
    print(">>> Press Enter to unmount and exit...")
    input()

    records = ws.ops.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, {total} bytes")
