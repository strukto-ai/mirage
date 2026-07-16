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
import shutil
import tempfile
import uuid
from collections.abc import Awaitable, Callable

from mirage import MountMode, Workspace
from mirage.resource.disk import DiskResource
from mirage.resource.ram import RAMResource
from mirage.resource.redis import RedisResource

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")


async def _noop() -> None:
    return None


def build_ram(mount: dict,
              run_id: str) -> tuple[object, Callable[[], Awaitable[None]]]:
    return RAMResource(), _noop


def build_disk(mount: dict,
               run_id: str) -> tuple[object, Callable[[], Awaitable[None]]]:
    root = tempfile.mkdtemp(prefix=f"mirage-integ-disk-{run_id}-")

    async def cleanup() -> None:
        shutil.rmtree(root, ignore_errors=True)

    return DiskResource(root=root), cleanup


def build_redis(mount: dict,
                run_id: str) -> tuple[object, Callable[[], Awaitable[None]]]:
    safe_path = mount["path"].strip("/").replace("/", "-") or "root"
    prefix = f"mirage-integ-{run_id}-{safe_path}/"
    return RedisResource(url=REDIS_URL, key_prefix=prefix), _noop


BUILDERS = {"ram": build_ram, "disk": build_disk, "redis": build_redis}


async def open_target(
        target: dict) -> tuple[Workspace, Callable[[], Awaitable[None]]]:
    run_id = uuid.uuid4().hex[:8]
    mounts: dict[str, object] = {}
    cleanups: list[Callable[[], Awaitable[None]]] = []
    for mount in target["mounts"]:
        builder = BUILDERS[mount["resource"]]
        resource, cleanup = builder(mount, run_id)
        mounts[mount["path"]] = resource
        cleanups.append(cleanup)
    ws = Workspace(mounts, mode=MountMode.WRITE)

    async def cleanup_all() -> None:
        await ws.close()
        for cleanup in cleanups:
            await cleanup()

    return ws, cleanup_all
