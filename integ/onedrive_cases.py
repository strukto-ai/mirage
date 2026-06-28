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
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cases import run_cases  # noqa: E402
from onedrive_server import start_fake_graph  # noqa: E402

from mirage import MountMode, Workspace  # noqa: E402
from mirage.accessor.onedrive import OneDriveConfig  # noqa: E402
from mirage.resource.onedrive.onedrive import OneDriveResource  # noqa: E402


async def main() -> None:
    _state, _server, runner = await start_fake_graph()
    try:
        resource = OneDriveResource(OneDriveConfig(access_token="integ-token"))
        ws = Workspace({"/data": resource}, mode=MountMode.WRITE)
        await run_cases(ws)
    finally:
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
