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

from mirage.commands.registry import RegisteredCommand
from mirage.commands.spec import SPECS
from mirage.io.types import IOResult
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def _run(ws, cmd, cwd="/"):
    ws._cwd = cwd
    return asyncio.run(ws.execute(cmd))


def test_filetype_fns_passed_to_generic_command():
    ws = Workspace(
        {"/tmp/": RAMResource()},
        mode=MountMode.WRITE,
    )
    asyncio.run(ws.fs.write("/tmp/a.txt", b"hello"))

    received = {}

    async def my_cat(store, paths, texts, opts):
        received["filetype_fns"] = opts.filetype_fns
        return b"ok", IOResult()

    async def my_cat_parquet(store, paths, texts, opts):
        return b"parquet-ok", IOResult()

    mount = ws._registry.mount_for("/tmp/")
    mount.register(
        RegisteredCommand("mycat",
                          spec=SPECS["cat"],
                          resource="ram",
                          filetype=None,
                          fn=my_cat))
    mount.register(
        RegisteredCommand("mycat",
                          spec=SPECS["cat"],
                          resource="ram",
                          filetype=".parquet",
                          fn=my_cat_parquet))

    _run(ws, "mycat /tmp/a.txt")
    assert received["filetype_fns"] is not None
    assert ".parquet" in received["filetype_fns"]
    assert received["filetype_fns"][".parquet"] is my_cat_parquet


def test_filetype_fns_not_passed_to_filetype_command():
    ws = Workspace(
        {"/tmp/": RAMResource()},
        mode=MountMode.WRITE,
    )
    asyncio.run(ws.fs.write("/tmp/a.parquet", b"fake-parquet"))

    received = {}

    async def my_cat(store, paths, texts, opts):
        return b"generic", IOResult()

    async def my_cat_parquet(store, paths, texts, opts):
        received["filetype_fns"] = opts.filetype_fns
        return b"parquet", IOResult()

    mount = ws._registry.mount_for("/tmp/")
    mount.register(
        RegisteredCommand("mycat",
                          spec=SPECS["cat"],
                          resource="ram",
                          filetype=None,
                          fn=my_cat))
    mount.register(
        RegisteredCommand("mycat",
                          spec=SPECS["cat"],
                          resource="ram",
                          filetype=".parquet",
                          fn=my_cat_parquet))

    _run(ws, "mycat /tmp/a.parquet")
    fns = received.get("filetype_fns", {})
    assert fns is None or len(fns) == 0


def test_filetype_fns_empty_when_no_variants():
    ws = Workspace(
        {"/tmp/": RAMResource()},
        mode=MountMode.WRITE,
    )
    asyncio.run(ws.fs.write("/tmp/a.txt", b"hello"))

    received = {}

    async def my_echo(store, paths, texts, opts):
        received["filetype_fns"] = opts.filetype_fns
        return b"ok", IOResult()

    ws._registry.mount_for("/tmp/").register(
        RegisteredCommand("myecho",
                          spec=SPECS["echo"],
                          resource="ram",
                          filetype=None,
                          fn=my_echo))

    _run(ws, "myecho /tmp/a.txt")
    fns = received.get("filetype_fns", {})
    assert fns is not None
    assert len(fns) == 0


def test_a_directory_does_not_route_to_a_filetype_handler():
    """A filetype handler is chosen from the operand's NAME, and a
    directory can carry any extension, so the cascade would hand a
    renderer a directory to read. Registering a `.tally` renderer for
    `cat` made `cat /data/dir.tally` answer ENOENT while `wc` on the same
    path answered `Is a directory`: the renderer made the command worse
    than the built-in it replaced."""
    fired: list[str] = []

    async def renderer(accessor, paths, texts, opts):
        fired.append(paths[0].virtual)
        return b"rendered\n", IOResult()

    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    _run(ws, "mkdir -p /data/dir.tally")
    asyncio.run(ws.fs.write("/data/dir.tally/inside.txt", b"nested\n"))
    asyncio.run(ws.fs.write("/data/file.tally", b"raw\n"))
    ws._registry.mount_for("/data/").register(
        RegisteredCommand("cat",
                          spec=SPECS["cat"],
                          resource="ram",
                          filetype=".tally",
                          fn=renderer))

    io = _run(ws, "cat /data/dir.tally")
    assert fired == []
    assert b"Is a directory" in (io.stderr or b"")
    assert io.exit_code == 1

    io = _run(ws, "cat /data/file.tally")
    assert fired == ["/data/file.tally"]
    assert asyncio.run(io.stdout_str()) == "rendered\n"
