from dataclasses import replace
from unittest.mock import AsyncMock

import pytest

from mirage.commands.builtin.generic_bind.adapter import (
    CommandIO,
    with_command_guards,
)
from mirage.commands.builtin.object_store.rm import make_rm
from mirage.commands.config import CommandOpts
from mirage.types import FileStat, FileType, PathSpec


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
