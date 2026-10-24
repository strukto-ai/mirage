import errno
from collections.abc import AsyncGenerator, AsyncIterator

import pytest

from mirage.commands.builtin.generic.sed import (
    _line_length,
    _script_origins,
    sed_generic,
    sed_writes,
)
from mirage.commands.config import Context
from mirage.commands.spec.types import FlagValue
from mirage.io.types import materialize
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.files import Files


def _spec(path: str) -> PathSpec:
    return PathSpec(
        vfs_path=(path).strip("/"),
        virtual=path,
        directory=path,
        resolved=True,
        raw_path=path,
    )


async def _resolved(paths: list[PathSpec]) -> list[PathSpec]:
    return paths


async def _no_read(path: PathSpec) -> AsyncIterator[bytes]:
    raise AssertionError(f"read {path.virtual}")
    yield b""


@pytest.mark.parametrize(
    "raw,width",
    [
        (None, 70),
        ("  +12", 12),
        ("-3", 0),
        ("x", 0),
        ("4294967297", 1),
        ("2147483648", 0),
        ("9" * 40, 0),
    ],
)
def test_line_length_reads_as_gnus_atoi(raw: str | None, width: int) -> None:
    assert _line_length(raw) == width


def test_script_origins_name_the_script_files() -> None:
    argv = ["-n", "-e", "p", "-f", "s.sed", "-fx.sed", "--line-length", "5"]
    assert _script_origins(argv, 3) == [None, "s.sed", "x.sed"]
    assert _script_origins(argv, 2) is None
    assert _script_origins([], 1) is None


@pytest.mark.parametrize(
    "flags,texts,writes",
    [
        ({}, ["p"], False),
        ({}, ["w /o"], True),
        ({}, ["s/a/b/w /dev/stdout"], True),
        ({"e": ["w /o", "k"]}, [], True),
        ({"e": ["k", "w /o"]}, [], False),
        ({"i": True}, ["p"], True),
        ({}, [], False),
    ],
)
def test_sed_writes_when_its_script_names_a_w_file(
    flags: dict[str, FlagValue], texts: list[str], writes: bool
) -> None:
    assert sed_writes(flags, texts) is writes


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "script,separate,out",
    [
        ("p", False, b"one\ntwo\nthree\n"),
        ("n;p", True, b"two\n"),
    ],
)
async def test_sed_reads_nothing_after_a_directory(
    script: str, separate: bool, out: bytes
) -> None:
    files = {"/f": b"one\ntwo\nthree\n", "/g": b"L1\nL2\n"}
    reads: list[str] = []

    async def read(path: PathSpec) -> AsyncIterator[bytes]:
        reads.append(path.virtual)
        if path.virtual == "/d":
            raise IsADirectoryError(errno.EISDIR, "Is a directory", "/d")
        yield files[path.virtual]

    ctx = Context(flags={"n": True, "separate": separate})
    output, io = await sed_generic(
        [_spec("/f"), _spec("/d"), _spec("/g")],
        [script],
        ctx,
        _resolved,
        read,
        False,
    )
    assert await materialize(output) == out
    assert io.exit_code == 4
    assert reads == ["/f", "/d"]


@pytest.mark.asyncio
async def test_repeated_stdin_operands_share_one_byte_cursor() -> None:
    output, io = await sed_generic(
        [_spec("-"), _spec("-")],
        [""],
        Context(stdin=b"x\n"),
        _resolved,
        _no_read,
        False,
    )
    assert await materialize(output) == b"x\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "script,code", [("w /data/saved", 0), ("w /data/saved\nq7", 7)]
)
async def test_reached_writes_and_status_survive_early_output_close(
    script: str, code: int
) -> None:
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        data = b"".join(b"%d\n" % n for n in range(100_000))
        ctx = Context(stdin=data, vfs=Files(ws.dispatch, ledger=False))
        output, io = await sed_generic(
            [], [script], ctx, _resolved, _no_read, True
        )
        assert isinstance(output, AsyncGenerator)
        first = await anext(output)
        await output.aclose()
        saved, _ = await ws.dispatch(
            "read", PathSpec.from_str_path("/data/saved")
        )
        assert first.startswith(b"0\n") and data.startswith(saved)
        assert len(first) <= len(saved) < len(data)
        assert io.exit_code == code
    finally:
        await ws.close()
