import pytest

from mirage.commands.builtin.generic.tac import parse_flags, tac
from mirage.types import PathSpec


def _read_stream(files: dict[str, bytes]):
    async def read_stream(path: PathSpec):
        if path.virtual not in files:
            raise FileNotFoundError(path.virtual)
        yield files[path.virtual]

    return read_stream


async def _drain(stdout) -> list[str]:
    if isinstance(stdout, bytes):
        return stdout.decode().splitlines()
    return b"".join([c async for c in stdout]).decode().splitlines()


@pytest.mark.asyncio
async def test_tac_stdin_reverses_lines():
    output, _ = await tac([], read_stream=_read_stream({}), stdin=b"a\nb\nc\n")
    assert await _drain(output) == ["c", "b", "a"]


@pytest.mark.asyncio
async def test_tac_file_reverses_lines():
    path = PathSpec(
        vfs_path="a.txt", virtual="/a.txt", directory="/a.txt", resolved=True
    )
    output, _ = await tac(
        [path], read_stream=_read_stream({"/a.txt": b"a\nb\nc\n"})
    )
    assert await _drain(output) == ["c", "b", "a"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data,before,expect",
    [
        (b"a|b|c|", True, b"||c|ba"),
        (b"a|b|c|", False, b"c|b|a|"),
        (b"\xff\xfe|\x80|", False, b"\x80|\xff\xfe|"),
    ],
)
async def test_tac_keeps_bytes_and_puts_b_before_the_record(
    data, before, expect
):
    out, _ = await tac(
        [],
        read_stream=_read_stream({}),
        stdin=data,
        separator="|",
        before=before,
    )
    got = out if isinstance(out, bytes) else b"".join([c async for c in out])
    assert got == expect


async def _refusing_bad(path: PathSpec):
    if path.virtual == "/bad":
        raise PermissionError(13, "Permission denied", "/bad")
    yield b"a\nb\n"


@pytest.mark.asyncio
async def test_a_file_that_fails_to_read_is_reported_and_tac_goes_on():
    bad = PathSpec(
        vfs_path="bad", virtual="/bad", directory="/", resolved=True
    )
    good = PathSpec(
        vfs_path="good", virtual="/good", directory="/", resolved=True
    )
    out, io = await tac([bad, good], read_stream=_refusing_bad)
    assert await _drain(out) == ["b", "a"]
    assert io.exit_code == 1
    assert b"/bad" in io.stderr


@pytest.mark.parametrize(
    "flags,separator", [({}, "\n"), ({"separator": ""}, "\0")]
)
def test_an_empty_separator_is_nul(flags, separator):
    assert parse_flags(flags).separator == separator


@pytest.mark.asyncio
async def test_a_raw_byte_separator_splits_on_that_byte():
    out, _ = await tac(
        [],
        read_stream=_read_stream({}),
        stdin=b"a\x80b\x80",
        separator="\udc80",
    )
    got = out if isinstance(out, bytes) else b"".join([c async for c in out])
    assert got == b"b\x80a\x80"
