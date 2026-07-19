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

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.dropbox import DropboxConfig, DropboxResource

load_dotenv(".env.development")

config = DropboxConfig(
    client_id=os.environ["DROPBOX_APP_KEY"],
    client_secret=os.environ["DROPBOX_APP_SECRET"],
    refresh_token=os.environ["DROPBOX_REFRESH_TOKEN"],
    # Mount a subfolder instead of the account root by setting
    # DROPBOX_ROOT_PATH, e.g. "/Team/data".
    root_path=os.environ.get("DROPBOX_ROOT_PATH") or "/",
)
backend = DropboxResource(config)
ws = Workspace({"/dropbox": backend}, mode=MountMode.READ)


async def show(cmd: str, max_chars: int = 600) -> None:
    print(f"=== {cmd} ===")
    result = await ws.execute(cmd)
    out = await result.stdout_str()
    if out:
        print(out[:max_chars] + ("..." if len(out) > max_chars else ""))
    err = (await result.stderr_str()).strip()
    if err:
        print(f"  STDERR: {err[:200]}")


async def main() -> None:
    await show("ls /dropbox/")
    await show("tree /dropbox/")
    await show("find /dropbox -name '*.txt' | head -n 5")
    await show("du /dropbox/")
    print("=== not-found errors show the full virtual path ===")
    result = await ws.execute("cat /dropbox/__nf_missing__.txt")
    print(f"exit={result.exit_code}  "
          f"{(await result.stderr_str()).strip()}")
    await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
