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

from mirage import RAMVFS, MountMode, Workspace
from mirage.vfs.gmail import GmailConfig, GmailVFS
from mirage.vfs.s3 import S3VFS, S3Config
from mirage.vfs.slack import SlackConfig, SlackVFS


async def main() -> None:
    ws = Workspace(
        {
            "/ram": RAMVFS(),
            "/s3": S3VFS(S3Config(bucket="demo", region="us-east-1")),
            "/slack": SlackVFS(SlackConfig(token="xoxb-demo")),
            "/gmail": GmailVFS(
                GmailConfig(
                    client_id="demo",
                    client_secret="demo",
                    refresh_token="demo",
                )
            ),
        },
        mode=MountMode.WRITE,
    )

    async def show(label: str, cmd: str) -> None:
        r = await ws.shell(cmd)
        print(f"\n========== {label} (exit {r.exit_code}) ==========")
        stdout = await r.stdout_str()
        stderr = await r.stderr_str()
        if stdout:
            print(stdout)
        if stderr:
            print(f"[stderr] {stderr}")

    await show("man cat", "man cat")
    await show("man find", "man find")
    await show("man grep", "man grep")
    await show("man rg (slack override)", "man rg")
    await show("man date (general only)", "man date")

    await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
