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

from mirage import MountMode, Workspace
from mirage.resource.ram import RAMResource


async def main() -> None:
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)

    await ws.ops.write("/data/report.txt", b"hello world")
    print("=== wrote /data/report.txt ===")

    # RAM registers no live_identity op, so the facade's capability probe
    # answers None rather than raising -- the same honest "unsupported"
    # a wired backend's missing op would give.
    identity = await ws.ops.live_identity("/data/report.txt")
    print("live_identity:", "None" if identity is None else "present")

    data, read_identity = await ws.ops.read_with_identity("/data/report.txt")
    print("read_with_identity bytes:", data.decode())
    print("read_with_identity identity:",
          "None" if read_identity is None else "present")


if __name__ == "__main__":
    asyncio.run(main())
