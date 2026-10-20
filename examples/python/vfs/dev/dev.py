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
from mirage.vfs.dev import DevVFS


async def main() -> None:
    # Every workspace mounts a DevVFS at /dev itself, so a second one there
    # is refused; another prefix takes its own.
    ws = Workspace({"/sandbox/dev": DevVFS()}, mode=MountMode.WRITE)

    print("=== ls /dev/ ===")
    result = await ws.shell("ls /dev/")
    print(await result.stdout_str())

    print("=== stat /dev/null ===")
    result = await ws.shell("stat /dev/null")
    print(await result.stdout_str())

    print("=== stat /dev/zero ===")
    result = await ws.shell("stat /dev/zero")
    print(await result.stdout_str())

    print("=== wc -c /dev/null (should be 0) ===")
    result = await ws.shell("wc -c /dev/null")
    print(await result.stdout_str())

    print("=== bounded read from /dev/zero (should be 2097152) ===")
    result = await ws.shell("head -c 2M /dev/zero | wc -c")
    print(await result.stdout_str())

    print("=== /dev/null device metadata ===")
    result = await ws.shell("stat -c '%F %t %T' /dev/null")
    print(await result.stdout_str())

    print("=== write to /dev/null is silently dropped ===")
    await ws.shell('echo "this disappears" | tee /dev/null')
    result = await ws.shell("wc -c /dev/null")
    print(f"after write: {await result.stdout_str()}")

    print("=== a DevVFS of its own at /sandbox/dev/ ===")
    result = await ws.shell(
        "ls /sandbox/dev/ && head -c 4 /sandbox/dev/zero | wc -c"
    )
    print(await result.stdout_str())

    await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
