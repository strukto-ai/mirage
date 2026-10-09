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

import errno

import pytest

from mirage import MountMode, Workspace
from mirage.commands.builtin.backends import commands_for
from mirage.types import PathSpec
from mirage.vfs.bin import BinViewVFS
from mirage.vfs.ram import RAMVFS
from tests.fixtures.vfs_io import DISPATCH_OPS, served


def test_view_registers_reads_and_refuses_every_write_op():
    vfs = BinViewVFS(lambda: ["ls"], lambda n: "ls" if n == "ls" else None)
    names = {cmd.name for cmd in commands_for(vfs)}
    # Every generic command registers, the writers included: `gzip -c`
    # reads the view like any reader, and a line that writes is refused
    # at the op the view does not have.
    assert {"cat", "ls", "stat", "gzip", "rm", "cp"} <= names
    assert served(vfs) == set(DISPATCH_OPS)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name,args",
    [
        ("write", (b"x",)),
        ("append", (b"x",)),
        ("create", ()),
        ("mkdir", ()),
        ("unlink", ()),
        ("rmdir", ()),
        ("truncate", (0,)),
    ],
)
async def test_every_write_answers_read_only(name, args):
    vfs = BinViewVFS(lambda: ["ls"], lambda n: "ls" if n == "ls" else None)
    with pytest.raises(OSError) as refused:
        await getattr(vfs, name)(PathSpec.from_str_path("/ls"), *args)
    assert refused.value.errno == errno.EROFS


@pytest.mark.asyncio
async def test_a_write_into_the_view_is_refused_as_read_only():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell("echo x > /usr/bin/ls")
    assert io.exit_code == 1
    assert await io.stderr_str() == "/usr/bin/ls: Read-only file system\n"
    io = await ws.shell("chmod 644 /usr/bin/ls; stat -c %a /usr/bin/ls")
    assert await io.stderr_str() == (
        "chmod: changing permissions of '/usr/bin/ls': Read-only file system\n"
    )
    assert await io.stdout_str() == "755\n"
    io = await ws.shell("rm /usr/bin/ls; gzip -c /usr/bin/ls | gunzip | wc -l")
    assert await io.stderr_str() == (
        "rm: cannot remove '/usr/bin/ls': Read-only file system\n"
    )
    assert await io.stdout_str() != "0\n"
