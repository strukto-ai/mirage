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
import io
from pathlib import Path

from mirage.agents.openai_agents.sandbox import MirageSandboxClient
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def _make_client() -> MirageSandboxClient:
    ram = RAMResource()
    ws = Workspace(
        {"/": (ram, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    return MirageSandboxClient(ws)


def test_create_session_with_default_resources():

    async def _run():
        client = _make_client()
        session = await client.create()
        result = await session.exec("echo hello", shell=False)
        assert result.exit_code == 0
        assert b"hello" in result.stdout

    asyncio.run(_run())


def test_session_file_read_write():

    async def _run():
        client = _make_client()
        session = await client.create()

        content = b"test file content"
        await session.write(Path("myfile.txt"), io.BytesIO(content))

        stream = await session.read(Path("myfile.txt"))
        assert stream.read() == content

    asyncio.run(_run())


def test_persist_and_hydrate_workspace():

    async def _run():
        client = _make_client()
        session = await client.create()
        await session.write(Path("data.txt"), io.BytesIO(b"persist me"))

        snapshot = await session.persist_workspace()

        client2 = _make_client()
        session2 = await client2.create()
        await session2.hydrate_workspace(snapshot)

        stream = await session2.read(Path("data.txt"))
        assert stream.read() == b"persist me"

    asyncio.run(_run())


def test_session_running_state():

    async def _run():
        client = _make_client()
        session = await client.create()
        assert await session.running() is True

    asyncio.run(_run())


def test_exec_names_the_reason_beside_a_refused_command():
    # stderr is bash's bare `Permission denied`; the reason rides the
    # refusal record, and a byte surface appends it as one more line.

    async def _run():
        ws = Workspace({"/": (RAMResource(), MountMode.WRITE)},
                       mode=MountMode.WRITE,
                       route_policy=lambda ctx: {"deny": "no deletes"}
                       if ctx.command == "rm" else None)
        session = await MirageSandboxClient(ws).create()
        result = await session.exec("rm /x", shell=False)
        assert result.exit_code == 126
        assert result.stderr == (
            b"rm: Permission denied\npolicy denied: no deletes\n")

    asyncio.run(_run())
