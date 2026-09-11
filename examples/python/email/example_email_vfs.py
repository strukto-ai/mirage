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
from mirage.resource.email import EmailConfig, EmailResource

load_dotenv(".env.development")

config = EmailConfig(
    imap_host=os.environ["IMAP_HOST"],
    smtp_host=os.environ["SMTP_HOST"],
    username=os.environ["EMAIL_USERNAME"],
    password=os.environ["EMAIL_PASSWORD"],
    max_messages=20,
)
resource = EmailResource(config=config)


async def main():
    with Workspace({"/email/": resource}, mode=MountMode.READ) as ws:
        print("=== VFS MODE ===\n")

        print("--- os.listdir() folders ---")
        folders = os.listdir("/email")
        for f in folders:
            print(f"  {f}")

        folder = "Inbox"
        if not any("Inbox" in f or "INBOX" in f for f in folders):
            folder = folders[0] if folders else ""
        if not folder:
            print("No folders")
            return

        print(f"\n--- os.listdir() {folder} dates ---")
        dates = os.listdir(f"/email/{folder}")
        for d in dates[:5]:
            print(f"  {d}")

        if dates:
            first_date = dates[0]
            print(f"\n--- os.listdir() {first_date} messages ---")
            messages = os.listdir(f"/email/{folder}/{first_date}")
            for msg in messages[:5]:
                print(f"  {msg}")

            json_msgs = [m for m in messages if m.endswith(".email.json")]
            if json_msgs:
                first = json_msgs[0]
                path = f"/email/{folder}/{first_date}/{first}"
                print(f"\n--- open() + read {first[:60]} ---")
                with open(path) as f:
                    content = f.read()
                    parsed = json.loads(content)
                    print(f"  subject: {parsed.get('subject', 'N/A')}")
                    print(f"  from: {parsed.get('from', 'N/A')}")

                print("\n--- os.path.exists() ---")
                print(f"  {first}: {os.path.exists(path)}")
                nope = f"/email/{folder}/nope.txt"
                print(f"  nope.txt: {os.path.exists(nope)}")

        records = ws.fs.records
        total = sum(r.bytes for r in records)
        print(f"\nStats: {len(records)} ops, {total} bytes transferred")


asyncio.run(main())
