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
from mirage.vfs.box import BoxConfig, BoxVFS

load_dotenv(".env.development")


def build_config() -> BoxConfig:
    dev_token = os.environ.get("BOX_DEVELOPER_TOKEN") or os.environ.get(
        "BOX_ACCESS_TOKEN"
    )
    if dev_token:
        return BoxConfig(access_token=dev_token)
    client_id = os.environ.get("BOX_CLIENT_ID")
    client_secret = os.environ.get("BOX_CLIENT_SECRET")
    enterprise_id = os.environ.get("BOX_ENTERPRISE_ID")
    if client_id and client_secret and enterprise_id:
        return BoxConfig(
            client_id=client_id,
            client_secret=client_secret,
            enterprise_id=enterprise_id,
        )
    refresh_token = os.environ.get("BOX_REFRESH_TOKEN")
    if not (client_id and client_secret and refresh_token):
        raise RuntimeError(
            "Provide BOX_DEVELOPER_TOKEN, or BOX_CLIENT_ID + "
            "BOX_CLIENT_SECRET + BOX_ENTERPRISE_ID (service account), or "
            "BOX_CLIENT_ID + BOX_CLIENT_SECRET + BOX_REFRESH_TOKEN"
        )
    return BoxConfig(
        client_id=client_id,
        client_secret=client_secret,
        refresh_token=refresh_token,
    )


vfs = BoxVFS(build_config())

with Workspace(
    {"/box": Mount(vfs, mode=MountMode.READ, backend=MountBackend.FUSE)}
) as ws:
    mp = ws.fuse_mountpoint

    print(f"=== FUSE MODE: mounted at {mp} ===\n")
    top = os.listdir(mp)
    for e in top[:10]:
        print(f"  {e}")
    if len(top) > 10:
        print(f"  ... ({len(top)} total)")

    if top:
        path = f"{mp}/{top[0]}"
        st = os.stat(path)
        print(
            f"\n--- stat {top[0]} → isDir={stat_mod.S_ISDIR(st.st_mode)} "
            f"size={st.st_size}"
        )
        if stat_mod.S_ISREG(st.st_mode) and st.st_size < 1024 * 1024:
            with open(path, encoding="utf-8") as f:
                print(f.read()[:200])

    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> Try in another terminal:")
    print(f">>>   ls {mp}/")
    print(f">>>   find {mp} -type f | head")
    print(">>> Press Enter to unmount and exit...")
    input()
