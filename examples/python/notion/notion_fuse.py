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
from mirage.resource.notion import NotionConfig, NotionResource

load_dotenv(".env.development")

config = NotionConfig(api_key=os.environ["NOTION_API_KEY"])
resource = NotionResource(config=config)

with Workspace({"/notion/": Mount(resource, mode=MountMode.READ,
                                  fuse=True)}) as ws:
    mp = ws.fuse_mountpoint

    print(f"=== FUSE MODE: mounted at {mp} ===\n")

    print("--- os.listdir() pages ---")
    pages = os.listdir(f"{mp}/pages")
    for p in pages[:5]:
        print(f"  {p}")

    if pages:
        page = pages[0]
        page_path = f"{mp}/pages/{page}"

        print(f"\n--- os.listdir() {page} ---")
        contents = os.listdir(page_path)
        for c in contents:
            print(f"  {c}")

        print("\n--- open() page.json ---")
        with open(f"{page_path}/page.json") as f:
            data = json.loads(f.read())
            print(f"  title: {data.get('title')}")
            print(f"  url: {data.get('url')}")

    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> Open another terminal and run:")
    print(f">>>   ls {mp}/pages/")
    print(f">>>   cat {mp}/pages/<page>/page.json | jq .title")
    print(">>> Press Enter to unmount and exit...")
    input()

    records = ws.ops.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, {total} bytes")
