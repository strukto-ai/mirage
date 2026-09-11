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

import pytest

from mirage.commands.registry import RegisteredCommand
from mirage.commands.spec import SPECS, CommandSpec
from mirage.io.types import IOResult
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


@pytest.mark.asyncio
async def test_registered_command_dispatch():
    ws = Workspace(
        {"/tmp/": RAMResource()},
        mode=MountMode.WRITE,
    )
    await ws.fs.write("/tmp/a.txt", b"hello")

    async def my_cat(store, paths, *texts, stdin=None, **flags):
        return b"custom-cat", IOResult()

    rc = RegisteredCommand("cat",
                           spec=SPECS["cat"],
                           resource="ram",
                           filetype=None,
                           fn=my_cat)
    ws._registry.mount_for("/tmp/").register(rc)

    ws._cwd = "/"
    result = await ws.execute("cat /tmp/a.txt")
    assert result.stdout == b"custom-cat"


@pytest.mark.asyncio
async def test_registered_filetype_dispatch():
    ws = Workspace(
        {"/tmp/": RAMResource()},
        mode=MountMode.WRITE,
    )
    await ws.fs.write("/tmp/data.avro", b"avro-data")

    async def cat_avro(store, paths, *texts, stdin=None, **flags):
        return b"avro-output", IOResult()

    rc = RegisteredCommand("cat",
                           spec=SPECS["cat"],
                           resource="ram",
                           filetype=".avro",
                           fn=cat_avro)
    ws._registry.mount_for("/tmp/").register(rc)

    ws._cwd = "/"
    result = await ws.execute("cat /tmp/data.avro")
    assert result.stdout == b"avro-output"


@pytest.mark.asyncio
async def test_filetype_takes_priority_over_generic():
    ws = Workspace(
        {"/tmp/": RAMResource()},
        mode=MountMode.WRITE,
    )
    await ws.fs.write("/tmp/data.avro", b"avro-data")

    async def cat_generic(store, paths, *texts, stdin=None, **flags):
        return b"generic", IOResult()

    async def cat_avro(store, paths, *texts, stdin=None, **flags):
        return b"avro", IOResult()

    mount = ws._registry.mount_for("/tmp/")
    mount.register(
        RegisteredCommand("cat",
                          spec=SPECS["cat"],
                          resource="ram",
                          filetype=None,
                          fn=cat_generic))
    mount.register(
        RegisteredCommand("cat",
                          spec=SPECS["cat"],
                          resource="ram",
                          filetype=".avro",
                          fn=cat_avro))

    ws._cwd = "/"
    result = await ws.execute("cat /tmp/data.avro")
    assert result.stdout == b"avro"

    await ws.fs.write("/tmp/data.csv", b"csv-data")
    result = await ws.execute("cat /tmp/data.csv")
    assert result.stdout == b"generic"


@pytest.mark.asyncio
async def test_registered_falls_back_to_builtin():
    ws = Workspace(
        {"/tmp/": RAMResource()},
        mode=MountMode.WRITE,
    )
    await ws.fs.write("/tmp/a.txt", b"hello world")
    ws._cwd = "/"
    result = await ws.execute("wc -l /tmp/a.txt")
    out = await result.stdout_str()
    assert "0" in out or "1" in out


def test_general_command_dispatch():
    ws = Workspace(
        {"/tmp/": RAMResource()},
        mode=MountMode.WRITE,
    )

    async def my_stat(store, paths, *texts, stdin=None, **flags):
        return b"custom-stat", IOResult()

    rc = RegisteredCommand("stat",
                           spec=CommandSpec(),
                           resource="ram",
                           filetype=None,
                           fn=my_stat)
    ws._registry.mount_for("/tmp/").register(rc)

    ws._cwd = "/tmp"
    result = asyncio.run(ws.execute("stat /tmp/file.txt"))
    assert result.stdout == b"custom-stat"
