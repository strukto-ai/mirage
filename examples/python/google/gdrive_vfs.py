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
from mirage.resource.gdrive import GoogleDriveConfig, GoogleDriveResource

load_dotenv(".env.development")

config = GoogleDriveConfig(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)
resource = GoogleDriveResource(config=config)


async def main():
    with Workspace({"/gdrive/": resource}, mode=MountMode.READ) as ws:
        vos = sys.modules["os"]
        print(
            "=== VFS MODE: open() reads from Google Drive transparently ===\n")

        print("--- os.listdir() root ---")
        entries = vos.listdir("/gdrive")
        for e in entries[:10]:
            print(f"  {e}")

        gdoc = gsheet = gslide = None
        for e in entries:
            if ".gdoc.json" in e and not gdoc:
                gdoc = e
            if ".gsheet.json" in e and not gsheet:
                gsheet = e
            if ".gslide.json" in e and not gslide:
                gslide = e

        if gdoc:
            path = f"/gdrive/{gdoc}"
            print(f"\n--- open() Google Doc: {gdoc} ---")
            with open(path) as f:
                content = f.read()
                parsed = json.loads(content)
                print(f"  title: {parsed.get('title', 'N/A')}")
                print(f"  preview: {content[:200]}...")

        if gsheet:
            path = f"/gdrive/{gsheet}"
            print(f"\n--- open() Google Sheet: {gsheet} ---")
            with open(path) as f:
                content = f.read()
                parsed = json.loads(content)
                title = parsed.get("properties", {}).get("title", "N/A")
                num_sheets = len(parsed.get("sheets", []))
                print(f"  title: {title}")
                print(f"  sheets: {num_sheets}")

        if gslide:
            path = f"/gdrive/{gslide}"
            print(f"\n--- open() Google Slides: {gslide} ---")
            with open(path) as f:
                content = f.read()
                parsed = json.loads(content)
                print(f"  title: {parsed.get('title', 'N/A')}")
                print(f"  slides: {len(parsed.get('slides', []))}")

        print("\n--- os.path.exists() ---")
        if gdoc:
            print(f"  {gdoc}: {vos.path.exists(f'/gdrive/{gdoc}')}")
        print(f"  nonexistent: {vos.path.exists('/gdrive/nope.txt')}")

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
