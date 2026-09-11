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
from mirage.resource.notion import NotionConfig, NotionResource

load_dotenv(".env.development")

config = NotionConfig(api_key=os.environ["NOTION_API_KEY"])
resource = NotionResource(config=config)


async def main():
    with Workspace({"/notion/": resource}, mode=MountMode.READ) as ws:
        print("=== VFS MODE ===\n")

        print("--- os.listdir() root ---")
        entries = os.listdir("/notion")
        for e in entries:
            print(f"  {e}")

        print("\n--- os.listdir() pages ---")
        pages = os.listdir("/notion/pages")
        for p in pages[:5]:
            print(f"  {p}")

        if pages:
            page_path = f"/notion/pages/{pages[0]}"

            print(f"\n--- os.listdir() {page_path} ---")
            contents = os.listdir(page_path)
            for c in contents:
                print(f"  {c}")

            print("\n--- open() page.json ---")
            with open(f"{page_path}/page.json") as f:
                data = json.loads(f.read())
                print(f"  title: {data.get('title')}")
                print(f"  url: {data.get('url')}")
                md = data.get("markdown", "")[:200]
                print(f"  markdown (first 200 chars): {md}")

        records = ws.fs.records
        total = sum(r.bytes for r in records)
        print(f"\nStats: {len(records)} ops, {total} bytes")


asyncio.run(main())
