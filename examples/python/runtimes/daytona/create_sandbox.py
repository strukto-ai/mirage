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

# Create a sandbox from the mirage-fuse snapshot and print its id.
# The sandbox is yours: mirage only connects to it, so delete it when
# done (`daytona sandbox delete <id>` or the dashboard). The lifecycle
# knobs below are the safety net for a forgotten demo box.

import asyncio

from daytona import AsyncDaytona, CreateSandboxFromSnapshotParams
from dotenv import load_dotenv

load_dotenv(".env.development")

SNAPSHOT_NAME = "mirage-fuse"


async def main() -> None:
    client = AsyncDaytona()
    try:
        sandbox = await client.create(
            CreateSandboxFromSnapshotParams(
                snapshot=SNAPSHOT_NAME,
                auto_stop_interval=10,
                auto_delete_interval=30,
            ))
        print(sandbox.id)
    finally:
        await client.close()


if __name__ == "__main__":
    asyncio.run(main())
