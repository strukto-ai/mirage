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
import os
import stat as stat_mod

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.vfs.dropbox import DropboxConfig, DropboxVFS

load_dotenv(".env.development")

config = DropboxConfig(
    client_id=os.environ["DROPBOX_APP_KEY"],
    client_secret=os.environ["DROPBOX_APP_SECRET"],
    refresh_token=os.environ["DROPBOX_REFRESH_TOKEN"],
)
vfs = DropboxVFS(config)


async def main() -> None:
    with Workspace({"/dropbox": vfs}, mode=MountMode.READ) as ws:
        print("=== VFS MODE: open() reads from Dropbox transparently ===\n")

        print("--- os.listdir() root ---")
        entries = os.listdir("/dropbox")
        for e in entries[:10]:
            print(f"  {e}")
        if len(entries) > 10:
            print(f"  ... ({len(entries)} total)")

        if entries:
            path = f"/dropbox/{entries[0]}"
            print(f"\n--- os.stat({path}) ---")
            st = os.stat(path)
            print(f"  isDirectory: {stat_mod.S_ISDIR(st.st_mode)}")
            print(f"  isFile: {stat_mod.S_ISREG(st.st_mode)}")
            print(f"  size: {st.st_size}")

            if stat_mod.S_ISREG(st.st_mode) and st.st_size < 1024 * 1024:
                print(f"\n--- open({path}) + read (first 200 bytes) ---")
                with open(path, encoding="utf-8", errors="replace") as f:
                    print(f"  {f.read()[:200]}...")
            elif stat_mod.S_ISDIR(st.st_mode):
                print(f"\n--- os.listdir({path}) ---")
                for s in os.listdir(path)[:5]:
                    print(f"  {s}")

        records = ws.vfs.records
        total = sum(r.bytes for r in records)
        print(f"\nStats: {len(records)} ops, {total} bytes transferred")


if __name__ == "__main__":
    asyncio.run(main())
