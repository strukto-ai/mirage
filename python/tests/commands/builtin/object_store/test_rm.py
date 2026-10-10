from dataclasses import replace
from unittest.mock import AsyncMock

import pytest

from mirage.commands.builtin.generic_bind.adapter import with_command_guards
from mirage.commands.builtin.object_store.rm import make_rm
from mirage.commands.config import CommandIO, CommandOpts
from mirage.errors.fs import walk_declined
from mirage.types import FileStat, FileType, PathSpec
from mirage.view.types import MountView, NamespaceView


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "force,refusal,raw,code,stderr",
    [
        (
            False,
            "ELOOP",
            "loop/child",
            1,
            b"rm: cannot remove 'loop/child': "
            b"Too many levels of symbolic links\n",
        ),
        (True, "ENOENT", "", 0, None),
    ],
)
async def test_rm_refused_operand_keeps_spelling_and_continues(
    force, refusal, raw, code, stderr
):
    stat = AsyncMock(return_value=FileStat(name="ok", type=FileType.FILE))
    unlink = AsyncMock()
    io = CommandIO(
        readdir=AsyncMock(return_value=[]),
        read_bytes=AsyncMock(),
        read_stream=AsyncMock(),
        stat=stat,
        is_mounted=lambda _: True,
        unlink=unlink,
        rmdir=AsyncMock(),
        rm_r=AsyncMock(),
    )
    refused = replace(
        PathSpec.from_str_path("/data"), raw_path=raw, walk_error=refusal
    )
    valid = PathSpec.from_str_path("/data/ok")
    _, result = await make_rm("s3", with_command_guards)(
        None, [refused, valid], [], CommandOpts(flags={"f": force}, io=io)
    )
    assert (result.exit_code, result.stderr) == (code, stderr)
    assert stat.await_count == 1
    assert unlink.await_args.args[1] == valid


@pytest.mark.asyncio
async def test_rm_r_names_a_mount_below_and_fails():
    tree = {"/data": ["/data/a.txt", "/data/inner"]}

    async def readdir(_accessor, path, index=None):
        return tree.get(path.virtual, [])

    async def stat(_accessor, path, index=None):
        kind = FileType.DIRECTORY if path.virtual in tree else FileType.FILE
        return FileStat(name=path.virtual, type=kind)

    async def declined(_accessor, path, index=None):
        raise walk_declined("s3", "rm_r", path)

    unlink = AsyncMock()
    rmdir = AsyncMock()
    io = CommandIO(
        readdir=readdir,
        read_bytes=AsyncMock(),
        read_stream=AsyncMock(),
        stat=stat,
        is_mounted=lambda _: True,
        unlink=unlink,
        rmdir=rmdir,
        rm_r=declined,
    )
    roots = ["/data/inner"]
    ns = NamespaceView(
        mounts=MountView(
            descendants=lambda _v: roots,
            visible_descendants=lambda _v: roots,
            is_root=lambda v: v in roots,
            root_of=lambda _v: "/data",
        )
    )
    _, result = await make_rm("s3", with_command_guards)(
        None,
        [PathSpec.from_str_path("/data")],
        [],
        CommandOpts(flags={"r": True}, io=io, ns=ns),
    )
    assert result.exit_code == 1
    assert result.stderr == (
        b"rm: skipping '/data/inner', since it's on a different device\n"
    )
    assert [c.args[1].virtual for c in unlink.await_args_list] == [
        "/data/a.txt"
    ]
    rmdir.assert_not_awaited()
