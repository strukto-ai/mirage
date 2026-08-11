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

# Build the "mirage-fuse" Daytona snapshot once. Sandbox creation from
# a snapshot takes seconds; building this image inline would sit in
# the first captured line's path for many minutes. Run again after a
# mirage release to refresh the baked package.

import asyncio

from daytona import AsyncDaytona, CreateSnapshotParams, Image, Resources
from dotenv import load_dotenv

load_dotenv(".env.development")

SNAPSHOT_NAME = "mirage-fuse"

MIRAGE_GIT_SPEC = (
    "mirage-ai[s3,fuse] @ "
    "git+https://github.com/strukto-ai/mirage.git#subdirectory=python")


async def main() -> None:
    client = AsyncDaytona()
    image = (Image.debian_slim("3.12").run_commands(
        "apt-get update "
        "&& apt-get install -y --no-install-recommends "
        "    git fuse3 libfuse3-dev "
        "&& sed -i 's/^#user_allow_other/user_allow_other/' /etc/fuse.conf "
        "&& rm -rf /var/lib/apt/lists/*").pip_install(MIRAGE_GIT_SPEC))
    try:
        snapshot = await client.snapshot.create(
            CreateSnapshotParams(name=SNAPSHOT_NAME,
                                 image=image,
                                 resources=Resources(cpu=1, memory=1, disk=3)),
            on_logs=lambda line: print(f"  build: {line}"),
            timeout=0)
        print(f"snapshot ready: {snapshot.name}")
    finally:
        await client.close()


if __name__ == "__main__":
    asyncio.run(main())
