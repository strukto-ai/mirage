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
from mirage.resource.slack import SlackConfig, SlackResource

load_dotenv(".env.development")

config = SlackConfig(
    token=os.environ["SLACK_BOT_TOKEN"],
    search_token=os.environ.get("SLACK_USER_TOKEN"),
)
resource = SlackResource(config=config)


async def main():
    with Workspace({"/slack/": resource}, mode=MountMode.READ) as ws:
        vos = sys.modules["os"]
        print("=== VFS MODE: open() reads from Slack transparently ===\n")

        print("--- os.listdir() root ---")
        sections = vos.listdir("/slack")
        for s in sections:
            print(f"  {s}")

        print("\n--- os.listdir() channels ---")
        channels = vos.listdir("/slack/channels")
        for ch in channels[:5]:
            print(f"  {ch}")

        if channels:
            ch = next((c for c in channels if "general" in c), channels[0])
            ch_dir = f"/slack/channels/{ch}"
            print("\n--- os.listdir() dates ---")
            dates = vos.listdir(ch_dir)
            for d in dates[-5:]:
                print(f"  {d}")

            if dates:
                for d in reversed(dates):
                    path = f"{ch_dir}/{d}/chat.jsonl"
                    with open(path) as f:
                        content = f.read()
                    lines = [
                        line_text for line_text in content.strip().split("\n")
                        if line_text.strip()
                    ]
                    if lines:
                        print(f"\n--- open() + read {d} ---")
                        print(f"  messages: {len(lines)}")
                        for line in lines[:3]:
                            rec = json.loads(line)
                            user = rec.get("user", "?")
                            text = rec.get("text", "")[:80]
                            print(f"  [{user}] {text}")
                        break
                else:
                    print("\n  (no messages found in recent dates)")

                print("\n--- os.path.exists() ---")
                print(f"  exists: {vos.path.exists(path)}")
                print(
                    f"  nonexistent: {vos.path.exists('/slack/channels/nope')}"
                )

        print("\n--- session observer ---")
        day_folders = vos.listdir("/.sessions")
        day_dir = f"/.sessions/{day_folders[0]}" if day_folders else None
        log_entries = vos.listdir(day_dir) if day_dir else []
        for e in log_entries:
            print(f"  {day_dir}/{e}")
        if log_entries and day_dir:
            with open(f"{day_dir}/{log_entries[0]}") as f:
                for i, line in enumerate(f):
                    if i >= 3:
                        break
                    print(f"  [{i}] {line.strip()[:120]}")

        records = ws.ops.records
        total = sum(r.bytes for r in records)
        print(f"\nStats: {len(records)} ops, {total} bytes transferred")


asyncio.run(main())
