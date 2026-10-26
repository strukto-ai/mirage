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

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.vfs.tidb_filesystem import (
    TiDBFilesystemConfig,
    TiDBFilesystemVFS,
)

load_dotenv(".env.development")

config = TiDBFilesystemConfig(
    host=os.environ["TIDB_FILESYSTEM_HOST"],
    token=os.environ["TIDB_FILESYSTEM_TOKEN"],
    root_path=os.environ.get("TIDB_FILESYSTEM_ROOT_PATH", "/"),
)
vfs = TiDBFilesystemVFS(config)


async def _run(ws: Workspace, cmd: str) -> None:
    print(f"\n>>> {cmd}")
    result = await ws.shell(cmd)
    stdout = (await result.stdout_str()).strip()
    stderr = (await result.stderr_str()).strip()
    if stdout:
        for line in stdout.splitlines()[:12]:
            print(f"  {line[:140]}")
    if stderr:
        print(f"  [stderr] {stderr[:140]}")
    if not stdout and not stderr:
        print(f"  (empty, exit={result.exit_code})")


async def main() -> None:
    ws = Workspace({"/fs": vfs}, mode=MountMode.WRITE)
    try:
        await _run(ws, "mkdir -p /fs/mirage-example/notes")
        await _run(
            ws, "echo 'hello from mirage' > /fs/mirage-example/notes/a.txt"
        )
        await _run(ws, "seq 1 20000 > /fs/mirage-example/numbers.txt")
        await _run(ws, "ls -l /fs/mirage-example /fs/mirage-example/notes")
        await _run(ws, "cat /fs/mirage-example/notes/a.txt")
        await _run(ws, "tail -n 2 /fs/mirage-example/numbers.txt")
        await _run(ws, "grep -c 9 /fs/mirage-example/numbers.txt")
        await _run(ws, "mv /fs/mirage-example/notes /fs/mirage-example/moved")
        await _run(ws, "find /fs/mirage-example | sort")
        await _run(ws, "cat /fs/mirage-example/nope.txt")
        await _run(ws, "rm -r /fs/mirage-example")
    finally:
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
