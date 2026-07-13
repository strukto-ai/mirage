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
import subprocess

from dotenv import load_dotenv

from mirage import Mount, MountMode, Workspace
from mirage.resource.slack import SlackConfig, SlackResource

load_dotenv(".env.development")

config = SlackConfig(
    token=os.environ["SLACK_BOT_TOKEN"],
    search_token=os.environ.get("SLACK_USER_TOKEN"),
)
resource = SlackResource(config=config)

with Workspace({"/slack/": Mount(resource, mode=MountMode.READ,
                                 fuse=True)}) as ws:
    mp = ws.fuse_mountpoint

    print(f"=== FUSE MODE: mounted at {mp} ===\n")

    print("--- os.listdir() root ---")
    sections = os.listdir(mp)
    for s in sections:
        print(f"  {s}")

    print("\n--- os.listdir() channels ---")
    channels = os.listdir(f"{mp}/channels")
    for ch in channels[:5]:
        print(f"  {ch}")

    if channels:
        ch = next((c for c in channels if "general" in c), channels[0])

        print(f"\n--- os.listdir() {ch} (last 5 dates) ---")
        dates = os.listdir(f"{mp}/channels/{ch}")
        for d in dates[-5:]:
            print(f"  {d}")

        if dates:
            for d in reversed(dates):
                path = f"{mp}/channels/{ch}/{d}/chat.jsonl"
                if not os.path.exists(path):
                    continue
                # chat.jsonl has no size until fetched: unopened it stats as
                # 0 bytes; the open below hydrates it, and stat/wc then
                # report the real size (see docs/python/setup/fuse.mdx).
                pre_size = os.stat(path).st_size
                with open(path) as f:
                    text = f.read().strip()
                if text:
                    lines = [ln for ln in text.splitlines() if ln.strip()]
                    print(
                        f"\n--- size-unknown semantics on {d}/chat.jsonl ---")
                    print(f"  stat before open: {pre_size} bytes")
                    wc = subprocess.run(["wc", "-lc", path],
                                        capture_output=True,
                                        text=True)
                    n_lines, n_bytes = wc.stdout.split()[:2]
                    print(f"  wc -lc          : {n_lines} messages, "
                          f"{n_bytes} bytes")
                    print(f"  stat after read : {os.stat(path).st_size} bytes")
                    print(f"\n--- open() + read {d}/chat.jsonl ---")
                    print(f"  messages: {len(lines)}")
                    for line in lines[:3]:
                        try:
                            msg = json.loads(line)
                        except json.JSONDecodeError:
                            break
                        user = msg.get("user", "?")
                        content = msg.get("text", "")[:80]
                        print(f"  [{user}] {content}")
                    break
            else:
                print("\n  (no messages found in recent dates)")

    print("\n--- os.listdir() users ---")
    users = os.listdir(f"{mp}/users")
    for u in users[:5]:
        print(f"  {u}")

    if users:
        user_path = f"{mp}/users/{users[0]}"
        print(f"\n--- open() + read {users[0]} ---")
        with open(user_path) as f:
            text = f.read().strip()
        if text:
            try:
                data = json.loads(text)
                print(f"  name: {data.get('name')}")
                print(f"  id: {data.get('id')}")
                print(f"  is_bot: {data.get('is_bot')}")
            except json.JSONDecodeError:
                print(f"  (raw: {text[:100]})")
        else:
            print("  (empty)")

    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> Open another terminal and run:")
    print(f">>>   ls {mp}/")
    print(f">>>   cat {mp}/channels/<channel>/<date>/chat.jsonl")
    print(">>> Press Enter to unmount and exit...")
    input()

    records = ws.ops.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, {total} bytes transferred")
