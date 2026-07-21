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
import json
import os
from pathlib import Path

from mirage import MountMode, Workspace
from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.resource.nextcloud import NextcloudConfig, NextcloudResource
from mirage.types import PathSpec
from mirage.watch import enable_watch

CASES = json.loads((Path(__file__).resolve().parent / "resources" /
                    "watch_nextcloud.json").read_text())
URL = os.environ.get(
    "NEXTCLOUD_URL",
    "http://localhost:8080/remote.php/dav/files/admin/",
)
USERNAME = os.environ.get("NEXTCLOUD_USERNAME", "admin")
PASSWORD = os.environ.get("NEXTCLOUD_PASSWORD", "admin123")
EVENT_TIMEOUT = 20.0


async def _mutate_externally(op: object, mutate: dict) -> None:
    """Apply one mutation directly to the backend, bypassing the
    watched workspace so its cache is genuinely stale.

    Args:
        op (object): opendal operator of a separate accessor.
        mutate (dict): {"op", "path", "body"?} from the case file.
    """
    kind = mutate["op"]
    path = mutate["path"]
    if kind == "write":
        await op.write(path, mutate["body"].encode())
    elif kind == "delete":
        await op.delete(path)
    else:
        raise ValueError(f"unknown mutate op: {kind}")


async def _await_event(agen: object, want_path: str) -> object:
    """Return the next change for ``want_path``, skipping others.

    Args:
        agen (object): The ``watch`` async iterator.
        want_path (str): Virtual path the case expects.
    """

    async def _next_matching() -> object:
        while True:
            change = await agen.__anext__()
            if change.path.virtual == want_path:
                return change

    return await asyncio.wait_for(_next_matching(), timeout=EVENT_TIMEOUT)


async def main() -> None:
    mount = CASES["mount"]
    watch_dir = CASES["watch_dir"]
    config = NextcloudConfig(url=URL, username=USERNAME, password=PASSWORD)
    resource = NextcloudResource(config)
    ws = Workspace({mount: resource}, mode=MountMode.WRITE)
    external = NextcloudAccessor(config)
    op = external.operator()

    await ws.execute(f"rm -rf {watch_dir}")
    await ws.execute(f"mkdir -p {watch_dir}")
    for name in CASES["seed"]:
        await op.write(f"data/{name}", b"seed")

    watcher = enable_watch(ws, poll_interval=CASES["poll_interval"])
    agen = ws.watch(PathSpec.from_str_path(watch_dir))
    # Let the baseline pull snapshot the seeded state before mutating.
    await asyncio.sleep(CASES["poll_interval"] * 2)

    for case in CASES["cases"]:
        await _mutate_externally(op, case["mutate"])
        watcher.nudge(PathSpec.from_str_path(case["event"]["path"]))
        print(f"=== {case['name']} ===")
        try:
            change = await _await_event(agen, case["event"]["path"])
            print(f"event={change.kind.value} {change.path.virtual}")
        except TimeoutError:
            print(f"event=TIMEOUT {case['event']['path']}")
            continue
        verify = case["verify"]
        result = await ws.execute(verify["cmd"])
        out = (await result.stdout_str()).strip()
        if "contains" in verify:
            ok = verify["contains"] in out
            print(f"verify={'ok' if ok else 'MISS'} {verify['contains']!r}")
        elif "absent" in verify:
            ok = verify["absent"] not in out
            print(f"verify={'ok' if ok else 'MISS'} absent:{verify['absent']}")

    await agen.aclose()
    await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
