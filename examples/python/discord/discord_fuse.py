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
from mirage.resource.discord import DiscordConfig, DiscordResource

load_dotenv(".env.development")

config = DiscordConfig(token=os.environ["DISCORD_BOT_TOKEN"])
resource = DiscordResource(config=config)

with Workspace({"/discord/": Mount(resource, mode=MountMode.READ,
                                   fuse=True)}) as ws:
    mp = ws.fuse_mountpoint

    print(f"=== FUSE MODE: mounted at {mp} ===\n")

    # ── list guilds ──────────────────────────────
    print("--- os.listdir() guilds ---")
    guilds = os.listdir(mp)
    for g in guilds:
        print(f"  {g}")

    if not guilds:
        print("no guilds found")
    else:
        guild = guilds[0]

        # ── list guild contents ──────────────────
        print(f"\n--- os.listdir() {guild} ---")
        contents = os.listdir(f"{mp}/{guild}")
        for c in contents:
            print(f"  {c}")

        # ── list channels ────────────────────────
        print(f"\n--- os.listdir() {guild}/channels ---")
        channels = os.listdir(f"{mp}/{guild}/channels")
        for ch in channels:
            print(f"  {ch}")

        if channels:
            ch = channels[0]

            # ── list date files ──────────────────
            print(f"\n--- os.listdir() {ch} (last 5 dates) ---")
            dates = os.listdir(f"{mp}/{guild}/channels/{ch}")
            for d in dates[-5:]:
                print(f"  {d}")

            # ── read chat.jsonl ──────────────────
            if dates:
                target = dates[-1]
                date_dir = f"{mp}/{guild}/channels/{ch}/{target}"
                chat_path = f"{date_dir}/chat.jsonl"
                print(f"\n--- open() + read {target}/chat.jsonl ---")
                with open(chat_path) as f:
                    text = f.read().strip()
                if text:
                    for i, line in enumerate(text.splitlines()):
                        if i >= 5:
                            print("  ...")
                            break
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            msg = json.loads(line)
                        except json.JSONDecodeError:
                            break
                        author = msg.get("author", {}).get("username", "?")
                        content = msg.get("content", "")
                        print(f"  [{author}] {content[:80]}")
                else:
                    print("  (empty — no messages on this date)")
                # list attachments
                files_dir = f"{date_dir}/files"
                try:
                    atts = os.listdir(files_dir)
                except (FileNotFoundError, OSError):
                    atts = []
                if atts:
                    print(f"\n--- os.listdir() {target}/files ---")
                    for a in atts[:5]:
                        print(f"  {a}")

        # ── list members ─────────────────────────
        print(f"\n--- os.listdir() {guild}/members ---")
        members = os.listdir(f"{mp}/{guild}/members")
        for m in members:
            print(f"  {m}")

        if members:
            member_path = f"{mp}/{guild}/members/{members[0]}"
            print(f"\n--- open() + read {members[0]} ---")
            with open(member_path) as f:
                text = f.read().strip()
            if text:
                try:
                    data = json.loads(text)
                    user = data.get("user", {})
                    print(f"  username: {user.get('username')}")
                    print(f"  id: {user.get('id')}")
                except json.JSONDecodeError:
                    print(f"  (raw: {text[:100]})")
            else:
                print("  (empty)")

    # ── interactive: browse the mount in another terminal ──
    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> Open another terminal and run:")
    print(f">>>   ls {mp}/")
    print(f">>>   cat {mp}/<guild>/channels/<ch>/<date>/chat.jsonl")
    print(">>> Press Enter to unmount and exit...")
    input()

    # ── stats ────────────────────────────────────
    records = ws.ops.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, {total} bytes transferred")
