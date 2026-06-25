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
from mirage.resource.gsheets import GSheetsConfig, GSheetsResource

load_dotenv(".env.development")

config = GSheetsConfig(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)
resource = GSheetsResource(config=config)

with Workspace({"/gsheets/": Mount(resource, mode=MountMode.READ,
                                   fuse=True)}) as ws:
    mp = ws.fuse_mountpoint

    print(f"=== FUSE MODE: mounted at {mp} ===\n")

    print("--- os.listdir() root ---")
    roots = os.listdir(mp)
    for r in roots:
        print(f"  {r}")

    for section in ("owned", "shared"):
        section_path = f"{mp}/{section}"
        if not os.path.isdir(section_path):
            continue
        sheets = os.listdir(section_path)
        if not sheets:
            continue
        print(f"\n--- os.listdir() {section} (first 5) ---")
        for s in sheets[:5]:
            print(f"  {s}")

        first = sheets[0]
        path = f"{section_path}/{first}"
        print(f"\n--- open() + read {first[:60]} ---")
        with open(path) as f:
            content = f.read()
        parsed = json.loads(content)
        title = parsed.get("properties", {}).get("title", "N/A")
        print(f"  title: {title}")
        break

    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> Open another terminal and run:")
    print(f">>>   ls {mp}/")
    print(f">>>   ls {mp}/owned/")
    print(">>> Press Enter to unmount and exit...")
    input()

    records = ws.ops.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, {total} bytes transferred")
