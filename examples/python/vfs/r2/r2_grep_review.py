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
from mirage.vfs.r2 import R2VFS, R2Config

load_dotenv(".env.development")

config = R2Config(
    bucket=os.environ["R2_BUCKET"],
    account_id=os.environ.get("R2_ACCOUNT_ID"),
    endpoint_url=os.environ.get("R2_ENDPOINT_URL"),
    access_key_id=os.environ["R2_ACCESS_KEY_ID"],
    secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    region=os.environ.get("R2_REGION", "auto"),
)


async def run(ws: Workspace, cmd: str) -> None:
    print(f"\n$ {cmd}")
    result = await ws.shell(cmd)
    print("--- stdout ---")
    print((await result.stdout_str()).strip())
    err = (await result.stderr_str()).strip()
    if err:
        print("--- stderr ---")
        print(err)
    print(f"--- exit {result.exit_code} ---")


async def main() -> None:
    ws = Workspace({"/r2/": R2VFS(config)}, mode=MountMode.READ)
    try:
        await run(ws, "find /r2/Review -maxdepth 3 -type f")
        await run(ws, "echo ---")
        await run(ws, r'grep -RIl "Base3\|base3" /r2/Review || true')
    finally:
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
