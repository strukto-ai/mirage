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
import subprocess

import pytest

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


@pytest.fixture
def shell(tmp_path):
    return ShellTestEnv(tmp_path)


class ShellTestEnv:

    def __init__(self, tmp_path):
        self.tmp_path = tmp_path
        self.mem = RAMResource()
        self.ws = Workspace(
            {"/data": (self.mem, MountMode.WRITE)},
            mode=MountMode.WRITE,
        )
        self.ws.get_session(self.ws.default_session_id).cwd = "/data"

    def create_file(self, name: str, content: bytes):
        local_path = self.tmp_path / name
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(content)
        store = self.mem._store
        remote = "/" + name
        parts = remote.strip("/").split("/")
        for i in range(1, len(parts)):
            store.dirs.add("/" + "/".join(parts[:i]))
        store.files[remote] = content

    def native(self, cmd: str, stdin: bytes | None = None) -> str:
        result = subprocess.run(
            ["/bin/sh", "-c", cmd],
            cwd=str(self.tmp_path),
            capture_output=True,
            input=stdin,
        )
        return result.stdout.decode(errors="replace")

    def mirage(self, cmd: str, stdin: bytes | None = None) -> str:

        async def _run():
            io = await self.ws.execute(cmd, stdin=stdin)
            return await io.stdout_str()

        return asyncio.run(_run())

    def mirage_exit(self, cmd: str, stdin: bytes | None = None) -> int:
        io = asyncio.run(self.ws.execute(cmd, stdin=stdin))
        return io.exit_code

    def native_exit(self, cmd: str) -> int:
        result = subprocess.run(
            ["/bin/sh", "-c", cmd],
            cwd=str(self.tmp_path),
            capture_output=True,
        )
        return result.returncode
