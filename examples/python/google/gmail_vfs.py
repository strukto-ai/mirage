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
from mirage.resource.gmail import GmailConfig, GmailResource

load_dotenv(".env.development")

config = GmailConfig(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)
resource = GmailResource(config=config)


async def main():
    with Workspace({"/gmail/": resource}, mode=MountMode.READ) as ws:
        vos = sys.modules["os"]
        print("=== VFS MODE: open() reads from Gmail transparently ===\n")

        print("--- os.listdir() labels ---")
        labels = vos.listdir("/gmail")
        for label in labels:
            print(f"  {label}")

        print("\n--- os.listdir() INBOX (date folders) ---")
        dates = vos.listdir("/gmail/INBOX")
        for date in dates[:5]:
            print(f"  {date}")

        first_date = dates[0] if dates else None
        entries = vos.listdir(
            f"/gmail/INBOX/{first_date}") if first_date else []
        messages = [e for e in entries if e.endswith(".gmail.json")]
        for msg in messages[:5]:
            print(f"  {first_date}/{msg}")

        if messages:
            first = messages[0]
            path = f"/gmail/INBOX/{first_date}/{first}"
            print("\n--- open() + read first message ---")
            with open(path) as f:
                content = f.read()
                parsed = json.loads(content)
                print(f"  subject: {parsed.get('subject', 'N/A')}")
                print(f"  from: {parsed.get('from', 'N/A')}")
                print(f"  snippet: {parsed.get('snippet', '')[:120]}...")

            print("\n--- os.path.exists() ---")
            print(f"  {first}: {vos.path.exists(path)}")
            print(
                f"  nonexistent: {vos.path.exists('/gmail/INBOX/nope.json')}")

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
