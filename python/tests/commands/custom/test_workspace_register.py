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

from mirage.commands.registry import command
from mirage.commands.spec import CommandSpec, Operand
from mirage.io.types import IOResult
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def _register(ws, fn):
    mount = ws._registry.mount_for("/tmp/")
    for rc in fn._registered_commands:
        mount.register(rc)


def test_workspace_accepts_commands_param():

    @command("myecho",
             resource="ram",
             spec=CommandSpec(rest=Operand(type="str")))
    async def my_echo(store, paths, texts, opts):
        return " ".join(texts).encode(), IOResult()

    ws = Workspace(
        {"/tmp/": RAMResource()},
        mode=MountMode.WRITE,
    )
    _register(ws, my_echo)

    async def _run():
        result = await ws.execute("myecho hello world")
        return (await result.stdout_str()).strip()

    assert asyncio.run(_run()) == "hello world"


def test_workspace_register_method():
    ws = Workspace(
        {"/tmp/": RAMResource()},
        mode=MountMode.WRITE,
    )

    @command("myecho",
             resource="ram",
             spec=CommandSpec(rest=Operand(type="str")))
    async def my_echo(store, paths, texts, opts):
        return " ".join(texts).encode(), IOResult()

    _register(ws, my_echo)

    async def _run():
        result = await ws.execute("myecho hello")
        return (await result.stdout_str()).strip()

    assert asyncio.run(_run()) == "hello"


def test_workspace_user_command_overrides_builtin():

    @command("stat", resource="ram", spec=CommandSpec())
    async def my_stat(store, paths, texts, opts):
        return b"custom-stat", IOResult()

    ws = Workspace(
        {"/tmp/": RAMResource()},
        mode=MountMode.WRITE,
    )
    _register(ws, my_stat)
    ws._cwd = "/tmp/"

    async def _run():
        result = await ws.execute("stat /tmp/file.txt")
        return (await result.stdout_str()).strip()

    assert asyncio.run(_run()) == "custom-stat"


def test_backend_commands_method_returns_commands():
    backend = RAMResource()
    cmds = backend.commands()
    assert len(cmds) > 0
    assert all(c.resource == "ram" for c in cmds)
