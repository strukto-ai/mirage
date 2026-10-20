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

import os
import stat as stat_mod

from dotenv import load_dotenv

from mirage import Mount, MountBackend, MountMode, Workspace
from mirage.vfs.dropbox import DropboxConfig, DropboxVFS

load_dotenv(".env.development")

config = DropboxConfig(
    client_id=os.environ["DROPBOX_APP_KEY"],
    client_secret=os.environ["DROPBOX_APP_SECRET"],
    refresh_token=os.environ["DROPBOX_REFRESH_TOKEN"],
)
vfs = DropboxVFS(config)

with Workspace(
    {"/dropbox": Mount(vfs, mode=MountMode.READ, backend=MountBackend.FUSE)}
) as ws:
    mp = ws.fuse_mountpoint

    print(f"=== FUSE MODE: mounted at {mp} ===\n")

    print(f"--- os.listdir() {mp} (first 10) ---")
    top = os.listdir(mp)
    for e in top[:10]:
        print(f"  {e}")
    if len(top) > 10:
        print(f"  ... ({len(top)} total)")

    if top:
        path = f"{mp}/{top[0]}"
        st = os.stat(path)
        print(f"\n--- os.stat() {top[0]} ---")
        print(f"  isDirectory: {stat_mod.S_ISDIR(st.st_mode)}")
        print(f"  isFile: {stat_mod.S_ISREG(st.st_mode)}")
        print(f"  size: {st.st_size}")
        if stat_mod.S_ISREG(st.st_mode) and st.st_size < 1024 * 1024:
            print(f"\n--- open() + read {top[0]} (first 200 chars) ---")
            with open(path, encoding="utf-8") as f:
                print(f.read()[:200])

    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> Try in another terminal:")
    print(f">>>   ls {mp}/")
    print(f">>>   find {mp} -type f | head")
    print(">>> Press Enter to unmount and exit...")
    input()
