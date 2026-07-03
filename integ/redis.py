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

import sys
from pathlib import Path

_INTEG_DIR = str(Path(__file__).parent)
sys.path[:] = [p for p in sys.path if p not in (_INTEG_DIR, "")]

import asyncio  # noqa: E402
import os  # noqa: E402
import uuid  # noqa: E402

from mirage import MountMode, Workspace  # noqa: E402
from mirage.observe.redis_store import RedisObserverStore  # noqa: E402
from mirage.resource.redis import RedisResource  # noqa: E402

sys.path.insert(0, _INTEG_DIR)

from cases import assert_real_mtime, run_cases  # noqa: E402

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")


async def main() -> None:
    run_id = uuid.uuid4().hex[:8]
    prefix = f"mirage-integ-{run_id}/"
    resource = RedisResource(url=REDIS_URL, key_prefix=prefix)
    resource2 = RedisResource(url=REDIS_URL,
                              key_prefix=f"mirage-integ-xm-{run_id}/")
    observe = RedisObserverStore(url=REDIS_URL,
                                 key_prefix=f"mirage-integ-observer-{run_id}:")
    ws = Workspace({
        "/data": resource,
        "/data2": resource2
    },
                   mode=MountMode.WRITE,
                   observe=observe)
    await run_cases(ws)
    await assert_real_mtime(ws)
    await observe.clear()


if __name__ == "__main__":
    asyncio.run(main())
