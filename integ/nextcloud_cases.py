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
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from cases import run_cases  # noqa: E402

from mirage import MountMode, Workspace  # noqa: E402
from mirage.resource.nextcloud import NextcloudConfig  # noqa: E402
from mirage.resource.nextcloud import NextcloudResource  # noqa: E402

URL = os.environ.get(
    "NEXTCLOUD_URL",
    "http://localhost:8080/remote.php/dav/files/admin/",
)
USERNAME = os.environ.get("NEXTCLOUD_USERNAME", "admin")
PASSWORD = os.environ.get("NEXTCLOUD_PASSWORD", "admin123")

# The shared cases list /data with exact-diff truth, so they must run in an
# empty folder rather than the account root, which holds Nextcloud's default
# skeleton files.
SUBDIR = "integ-cases"
SUBDIR2 = "integ-cases-xm"


async def main() -> None:
    root = NextcloudResource(
        NextcloudConfig(url=URL, username=USERNAME, password=PASSWORD))
    boot = Workspace({"/root": root}, mode=MountMode.WRITE)
    await boot.execute(f"rm -rf /root/{SUBDIR}")
    await boot.execute(f"mkdir -p /root/{SUBDIR}")
    await boot.execute(f"rm -rf /root/{SUBDIR2}")
    await boot.execute(f"mkdir -p /root/{SUBDIR2}")
    cases_url = URL.rstrip("/") + f"/{SUBDIR}/"
    cases_url2 = URL.rstrip("/") + f"/{SUBDIR2}/"
    resource = NextcloudResource(
        NextcloudConfig(url=cases_url, username=USERNAME, password=PASSWORD))
    resource2 = NextcloudResource(
        NextcloudConfig(url=cases_url2, username=USERNAME, password=PASSWORD))
    ws = Workspace({
        "/data": resource,
        "/data2": resource2
    },
                   mode=MountMode.WRITE)
    await run_cases(ws)


if __name__ == "__main__":
    asyncio.run(main())
