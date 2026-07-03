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
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from cases import assert_real_mtime, run_cases  # noqa: E402

from mirage import MountMode, Workspace  # noqa: E402
from mirage.observe.disk_store import DiskObserverStore  # noqa: E402
from mirage.resource.disk import DiskResource  # noqa: E402


async def main() -> None:
    tmp = tempfile.mkdtemp(prefix="mirage-integ-disk-")
    tmp2 = tempfile.mkdtemp(prefix="mirage-integ-disk2-")
    obs_root = tempfile.mkdtemp(prefix="mirage-integ-observer-")
    try:
        ws = Workspace(
            {
                "/data": DiskResource(root=tmp),
                "/data2": DiskResource(root=tmp2)
            },
            mode=MountMode.WRITE,
            observe=DiskObserverStore(obs_root))
        await run_cases(ws)
        await assert_real_mtime(ws)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.rmtree(tmp2, ignore_errors=True)
        shutil.rmtree(obs_root, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
