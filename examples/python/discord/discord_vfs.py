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
import re
import stat as stat_mod

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.discord import DiscordConfig, DiscordResource

load_dotenv(".env.development")

config = DiscordConfig(token=os.environ["DISCORD_BOT_TOKEN"])
resource = DiscordResource(config=config)


async def main():
    with Workspace({"/discord/": resource}, mode=MountMode.READ) as ws:
        print("=== VFS MODE: open() reads from Discord transparently ===\n")

        print("--- os.listdir() guilds ---")
        guilds = os.listdir("/discord")
        for g in guilds:
            print(f"  {g}")

        if not guilds:
            return

        guild = guilds[0]
        guild_dir = f"/discord/{guild}"
        print(f"\n--- os.listdir() {guild_dir} ---")
        for s in os.listdir(guild_dir):
            print(f"  {s}")

        ch_root = f"{guild_dir}/channels"
        print(f"\n--- os.listdir() {ch_root} ---")
        channels = os.listdir(ch_root)
        for ch in channels[:5]:
            print(f"  {ch}")

        if not channels:
            return

        ch = channels[0]
        ch_dir = f"{ch_root}/{ch}"
        print(f"\n--- os.listdir() {ch_dir} (last 5 dates) ---")
        dates = os.listdir(ch_dir)
        for d in dates[-5:]:
            print(f"  {d}")

        if dates:
            for d in reversed(dates):
                chat_path = f"{ch_dir}/{d}/chat.jsonl"
                try:
                    with open(chat_path) as f:
                        content = f.read()
                except FileNotFoundError:
                    continue
                lines = [
                    line_text for line_text in content.strip().split("\n")
                    if line_text.strip()
                ]
                if lines:
                    print(f"\n--- open() + read {d}/chat.jsonl ---")
                    print(f"  messages: {len(lines)}")
                    for line in lines[:3]:
                        rec = json.loads(line)
                        author = rec.get("author", {}).get("username", "?")
                        text = rec.get("content", "")[:80]
                        print(f"  [{author}] {text}")
                    # also list attachments in that day's files dir
                    files_dir = f"{ch_dir}/{d}/files"
                    try:
                        atts = os.listdir(files_dir)
                    except FileNotFoundError:
                        atts = []
                    if atts:
                        print(f"\n--- os.listdir() {d}/files ---")
                        for a in atts[:5]:
                            print(f"  {a}")

                    print("\n--- os.path.isfile / isdir / exists ---")
                    print(f"  isfile(chat.jsonl): "
                          f"{os.path.isfile(chat_path)}")
                    print(f"  isdir(files/): "
                          f"{os.path.isdir(files_dir)}")
                    print(f"  exists(bogus): "
                          f"{os.path.exists(f'{ch_dir}/{d}/nope.txt')}")

                    print(f"\n--- os.stat {d}/chat.jsonl ---")
                    st = os.stat(chat_path)
                    print(f"  regular={stat_mod.S_ISREG(st.st_mode)} "
                          f"size={st.st_size}")

                    if atts:
                        att_path = f"{files_dir}/{atts[0]}"
                        print(f"\n--- os.stat {atts[0]} ---")
                        ast = os.stat(att_path)
                        print(f"  regular={stat_mod.S_ISREG(ast.st_mode)} "
                              f"size={ast.st_size}")

                        print(f"\n--- open({atts[0]}, 'rb') ---")
                        with open(att_path, "rb") as f:
                            blob = f.read()
                        # st_size is 0 when the backend cannot report a
                        # size before the file is read.
                        known = ast.st_size or None
                        print(f"  bytes={len(blob)} expected={known} "
                              f"match={known is None or len(blob) == known}")
                        if known is not None and len(blob) != known:
                            raise AssertionError(
                                f"regression: open('rb') got {len(blob)} "
                                f"bytes, expected {known}")

                    print("\n--- json.loads + regex search on chat.jsonl ---")
                    pattern = re.compile(r"\S+")
                    matches = 0
                    for raw in lines:
                        rec = json.loads(raw)
                        text = rec.get("content", "") or ""
                        if pattern.search(text):
                            matches += 1
                    print(f"  messages with non-whitespace content: "
                          f"{matches}/{len(lines)}")
                    break
            else:
                print("\n  (no messages found in recent dates)")

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
