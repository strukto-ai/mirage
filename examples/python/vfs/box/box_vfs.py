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


async def main() -> None:
    vfs = BoxVFS(build_config())
    with Workspace({"/box": vfs}, mode=MountMode.READ):
        print("=== VFS MODE: open() reads from Box transparently ===\n")
        entries = os.listdir("/box")
        for e in entries[:10]:
            print(f"  {e}")
        if len(entries) > 10:
            print(f"  ... ({len(entries)} total)")

        if entries:
            path = f"/box/{entries[0]}"
            st = os.stat(path)
            print(f"\n--- os.stat({path}) ---")
            print(
                f"  isDirectory: {stat_mod.S_ISDIR(st.st_mode)} "
                f"size: {st.st_size}"
            )

            if stat_mod.S_ISREG(st.st_mode) and st.st_size < 1024 * 1024:
                with open(path, encoding="utf-8") as f:
                    print(f"  {f.read()[:200]}...")
            elif stat_mod.S_ISDIR(st.st_mode):
                for s in os.listdir(path)[:5]:
                    print(f"  {s}")


if __name__ == "__main__":
    asyncio.run(main())
