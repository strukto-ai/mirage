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
        print("=== VFS MODE ===\n")

        print("--- os.listdir() labels ---")
        labels = os.listdir("/gmail")
        for label in labels:
            print(f"  {label}")

        print("\n--- os.listdir() INBOX dates ---")
        dates = os.listdir("/gmail/INBOX")
        for d in dates[:5]:
            print(f"  {d}")

        if dates:
            first_date = dates[0]
            print(f"\n--- os.listdir() {first_date} messages ---")
            messages = os.listdir(f"/gmail/INBOX/{first_date}")
            for msg in messages[:5]:
                print(f"  {msg}")

            json_msgs = [m for m in messages if m.endswith(".gmail.json")]
            if json_msgs:
                first = json_msgs[0]
                path = f"/gmail/INBOX/{first_date}/{first}"
                print(f"\n--- open() + read {first} ---")
                with open(path) as f:
                    content = f.read()
                    parsed = json.loads(content)
                    print(f"  subject: {parsed.get('subject', 'N/A')}")
                    print(f"  from: {parsed.get('from', 'N/A')}")

                print("\n--- os.path.exists() ---")
                print(f"  {first}: {os.path.exists(path)}")

        print("\n--- bash history ---")
        with open("/.bash_history") as f:
            for i, line in enumerate(f):
                if i >= 6:
                    break
                print(f"  {line.rstrip()[:120]}")

        records = ws.fs.records
        total = sum(r.bytes for r in records)
        print(f"\nStats: {len(records)} ops, {total} bytes transferred")


asyncio.run(main())
