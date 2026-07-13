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
from mirage.resource.gmail import GmailConfig, GmailResource

load_dotenv(".env.development")

config = GmailConfig(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)
resource = GmailResource(config=config)

with Workspace({"/gmail/": Mount(resource, mode=MountMode.READ,
                                 fuse=True)}) as ws:
    mp = ws.fuse_mountpoint

    print(f"=== FUSE MODE: mounted at {mp} ===\n")

    print("--- os.listdir() labels ---")
    labels = os.listdir(mp)
    for lb in labels:
        print(f"  {lb}")

    inbox_path = f"{mp}/INBOX"
    if os.path.isdir(inbox_path):
        print("\n--- os.listdir() INBOX (dates) ---")
        dates = os.listdir(inbox_path)
        for d in dates[:5]:
            print(f"  {d}")

        if dates:
            date_path = f"{inbox_path}/{dates[0]}"
            print(f"\n--- os.listdir() {dates[0]} ---")
            messages = os.listdir(date_path)
            for m in messages[:5]:
                print(f"  {m}")

            json_msgs = [m for m in messages if m.endswith(".gmail.json")]
            if json_msgs:
                first = json_msgs[0]
                path = f"{date_path}/{first}"

                # Size-unknown semantics: rendered .gmail.json length is not
                # knowable without rendering (Gmail's sizeEstimate is the
                # source message, not the render), so stat before open
                # reports 0; after a read the real size is served from the
                # hydrated handle.
                print("\n--- stat before open (expect size 0) ---")
                print(f"  st_size: {os.stat(path).st_size}")

                print(f"--- open() + read {first[:60]} ---")
                with open(path) as f:
                    content = f.read()
                parsed = json.loads(content)
                print(f"  subject: {parsed.get('subject', 'N/A')}")
                print(f"  from: {parsed.get('from', 'N/A')}")
                print(f"  rendered bytes: {len(content)}")

                print("--- stat after read (real rendered size) ---")
                print(f"  st_size: {os.stat(path).st_size}")

    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> Open another terminal and run:")
    print(f">>>   ls {mp}/")
    print(f">>>   ls {mp}/INBOX/")
    print(">>> Press Enter to unmount and exit...")
    input()

    records = ws.ops.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, {total} bytes transferred")
