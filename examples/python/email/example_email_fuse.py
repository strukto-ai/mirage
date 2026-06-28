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

with Workspace({"/email/": Mount(resource, mode=MountMode.READ,
                                 fuse=True)}) as ws:
    mp = ws.fuse_mountpoint

    print(f"=== FUSE MODE: mounted at {mp} ===\n")

    print("--- os.listdir() folders ---")
    folders = os.listdir(mp)
    for f in folders:
        print(f"  {f}")

    folder = "Inbox"
    if not any("Inbox" in f or "INBOX" in f for f in folders):
        folder = folders[0] if folders else ""

    folder_path = f"{mp}/{folder}"
    if os.path.isdir(folder_path):
        print(f"\n--- os.listdir() {folder} (dates) ---")
        dates = os.listdir(folder_path)
        for d in dates[:5]:
            print(f"  {d}")

        if dates:
            date_path = f"{folder_path}/{dates[0]}"
            print(f"\n--- os.listdir() {dates[0]} ---")
            messages = os.listdir(date_path)
            for m in messages[:5]:
                print(f"  {m}")

            json_msgs = [m for m in messages if m.endswith(".email.json")]
            if json_msgs:
                first = json_msgs[0]
                path = f"{date_path}/{first}"
                print(f"\n--- open() + read {first[:60]} ---")
                with open(path) as f:
                    content = f.read()
                parsed = json.loads(content)
                print(f"  subject: {parsed.get('subject', 'N/A')}")
                print(f"  from: {parsed.get('from', 'N/A')}")

    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> Open another terminal and run:")
    print(f">>>   ls {mp}/")
    print(f">>>   ls {mp}/{folder}/")
    print(">>> Press Enter to unmount and exit...")
    input()

    records = ws.ops.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, {total} bytes transferred")
