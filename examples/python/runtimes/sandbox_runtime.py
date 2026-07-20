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

from dotenv import load_dotenv

from mirage import MountMode, RAMResource, Workspace
from mirage.io.types import materialize
from mirage.runtime.table import build_runtime

load_dotenv(".env.development")

# One demo, any sandbox provider; the RemoteSandbox surface is
# uniform, so only the name changes:
#   python sandbox_runtime.py docker    (local, no credentials)
#   python sandbox_runtime.py daytona   (needs DAYTONA_API_KEY)
#   python sandbox_runtime.py e2b       (needs E2B_API_KEY)
PROVIDER = sys.argv[1] if len(sys.argv) > 1 else "docker"

SCRIPT = """\
import platform
import sys

print(f"hello from {platform.system()} {platform.machine()}")
print(f"python {sys.version.split()[0]}")
sys.stderr.write("stderr says hi\\n")
"""


async def show(workspace: Workspace, line: str, **kwargs: str) -> None:
    io = await workspace.execute(line, **kwargs)
    print(f"$ {line}")
    print((await materialize(io.stdout)).decode(), end="")
    if io.stderr is not None:
        err = (await materialize(io.stderr)).decode()
        if err:
            print(f"[stderr] {err}", end="")
    print(f"[exit {io.exit_code}]\n")


async def main() -> None:
    # The mac is the center: a local RAM mount holds the script.
    # python3 lines run whole in the sandbox (the workspace syncs
    # under the sandbox's workspace root first); everything else stays
    # local vfs. The sandbox is created lazily on the first captured
    # line and deleted when the workspace closes.
    remote = build_runtime(PROVIDER, captures=["python3"])
    workspace = Workspace({"/data": RAMResource()},
                          mode=MountMode.EXEC,
                          runtimes=[remote, "vfs"])
    try:
        await workspace.execute("cat > /data/hello.py", stdin=SCRIPT.encode())
        print("=== local vfs ===")
        await show(workspace, "ls -l /data")

        print(f"=== remote ({PROVIDER}) ===")
        await show(workspace, "python3 hello.py", cwd="/data")
        print(f"sandbox={remote.sandbox_id} root={remote.workspace_root}")
    finally:
        await workspace.close()


if __name__ == "__main__":
    asyncio.run(main())
