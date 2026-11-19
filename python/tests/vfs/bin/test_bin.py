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
from mirage.types import PathSpec
from mirage.vfs.bin import BinViewVFS
from mirage.vfs.ram import RAMVFS
from tests.fixtures.mount_commands import mount_commands
from tests.fixtures.vfs_io import DISPATCH_OPS, served


def test_view_registers_reads_and_refuses_every_write_op():
    vfs = BinViewVFS(lambda: ["ls"], lambda n: "ls" if n == "ls" else None)
    names = {cmd.name for cmd in mount_commands(vfs)}
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
    assert (
        await io.stderr_str()
        == "bash: line 1: /usr/bin/ls: Read-only file system\n"
    )
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


async def root_holding(files: dict[str, bytes]) -> RAMVFS:
    ram = RAMVFS()
    await ram.mkdir(PathSpec.from_str_path("/usr/bin"), parents=True)
    for path, data in files.items():
        await ram.write(PathSpec.from_str_path(path), data)
    return ram


@pytest.mark.asyncio
async def test_a_name_mirage_does_not_run_is_the_file_beneath_the_view():
    root = await root_holding(
        {"/usr/bin/perl": b"#!perl\n", "/usr/bin/grep": b"theirs\n"}
    )
    ws = Workspace({"/": root}, mode=MountMode.WRITE)
    assert (
        await (await ws.shell("cat /usr/bin/perl")).stdout_str() == "#!perl\n"
    )
    listed = await (
        await ws.shell("ls /usr/bin | grep -x -e perl -e grep")
    ).stdout_str()
    assert listed == "grep\nperl\n"
    grep = await (await ws.shell("cat /usr/bin/grep")).stdout_str()
    assert grep != "theirs\n" and "grep" in grep
    missing = await ws.shell("cat /usr/bin/nosuch")
    assert missing.exit_code == 1
    await ws.close()


@pytest.mark.asyncio
async def test_a_view_leaving_names_keeps_its_own_file_where_none_lies_beneath():
    beneath = await root_holding({"/usr/bin/perl": b"#!perl\n"})
    view = BinViewVFS(
        lambda: ["ls", "python3"],
        lambda n: n if n in ("ls", "python3") else None,
        leaves=lambda n: n != "ls",
        beneath=lambda v: (beneath, PathSpec.from_str_path(v)),
    )
    spec = PathSpec(virtual="/usr/bin", directory="/usr", vfs_path="")
    rows = await view.readdir(spec)
    assert [row.name for row in rows] == ["ls", "perl", "python3"]
    perl = PathSpec(
        virtual="/usr/bin/perl", directory="/usr/bin", vfs_path="perl"
    )
    assert (await view.stat(perl)).size == len(b"#!perl\n")
    assert await view.read(perl) == b"#!perl\n"
    python = PathSpec(
        virtual="/usr/bin/python3", directory="/usr/bin", vfs_path="python3"
    )
    assert b"python3" in await view.read(python)
    assert view.leaves("perl") and not view.leaves("ls")


@pytest.mark.asyncio
async def test_a_folder_beneath_the_view_opens_with_all_under_it():
    root = await root_holding({})
    await root.mkdir(PathSpec.from_str_path("/usr/bin/helpers"))
    await root.write(
        PathSpec.from_str_path("/usr/bin/helpers/tool"), b"#!tool\n"
    )
    ws = Workspace({"/": root}, mode=MountMode.WRITE)
    io = await ws.shell(
        "ls /usr/bin | grep -x helpers; ls /usr/bin/helpers; "
        "cat /usr/bin/helpers/tool; test -d /usr/bin/helpers && echo dir"
    )
    assert await io.stdout_str() == "helpers\ntool\n#!tool\ndir\n"
    missing = await ws.shell("ls /usr/bin/grep/x")
    assert missing.exit_code == 2
    await ws.close()
