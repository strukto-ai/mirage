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
from mirage.vfs.gdrive import GoogleDriveConfig, GoogleDriveVFS

load_dotenv(".env.development")

config = GoogleDriveConfig(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)
vfs = GoogleDriveVFS(config=config)


async def main():
    with Workspace({"/gdrive/": vfs}, mode=MountMode.READ) as ws:
        print("=== VFS MODE ===\n")

        print("--- os.listdir() root ---")
        entries = os.listdir("/gdrive")
        for e in entries[:10]:
            print(f"  {e}")

        if entries:
            first = entries[0]
            path = f"/gdrive/{first}"
            print(f"\n--- os.path.isdir({first}) ---")
            print(f"  {os.path.isdir(path)}")

            if os.path.isfile(path):
                print(f"\n--- open() + read {first} ---")
                with open(path) as f:
                    content = f.read()
                print(f"  {len(content)} bytes")

        # Docs, Sheets and Slides render to JSON with their own shapes.
        gdoc = next((e for e in entries if e.endswith(".gdoc.json")), None)
        gsheet = next((e for e in entries if e.endswith(".gsheet.json")), None)
        gslide = next((e for e in entries if e.endswith(".gslide.json")), None)

        if gdoc:
            print(f"\n--- open() Google Doc: {gdoc} ---")
            with open(f"/gdrive/{gdoc}") as f:
                content = f.read()
                parsed = json.loads(content)
                print(f"  title: {parsed.get('title', 'N/A')}")
                print(f"  preview: {content[:200]}...")

        if gsheet:
            print(f"\n--- open() Google Sheet: {gsheet} ---")
            with open(f"/gdrive/{gsheet}") as f:
                parsed = json.loads(f.read())
                title = parsed.get("properties", {}).get("title", "N/A")
                print(f"  title: {title}")
                print(f"  sheets: {len(parsed.get('sheets', []))}")

        if gslide:
            print(f"\n--- open() Google Slides: {gslide} ---")
            with open(f"/gdrive/{gslide}") as f:
                parsed = json.loads(f.read())
                print(f"  title: {parsed.get('title', 'N/A')}")
                print(f"  slides: {len(parsed.get('slides', []))}")

        print("\n--- os.path.exists() ---")
        if gdoc:
            print(f"  {gdoc}: {os.path.exists(f'/gdrive/{gdoc}')}")
        print(f"  nonexistent: {os.path.exists('/gdrive/nope.txt')}")

        print("\n--- bash history ---")
        with open("/.bash_history") as f:
            for i, line in enumerate(f):
                if i >= 6:
                    break
                print(f"  {line.rstrip()[:120]}")

        records = ws.vfs.records
        total = sum(r.bytes for r in records)
        print(f"\nStats: {len(records)} ops, {total} bytes transferred")


asyncio.run(main())
