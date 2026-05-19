import pytest

from mirage.commands.builtin.generic.awk import awk
from mirage.types import PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(original=path, directory=path, resolved=True)


def _make_backend(files: dict[str, bytes]):

    async def read_bytes(accessor, path, index=None):
        spec = path if isinstance(path, PathSpec) else PathSpec(original=path,
                                                                directory=path)
        key = spec.original if isinstance(path, PathSpec) else path
        if key not in files:
            raise FileNotFoundError(key)
        return files[key]

    async def read_stream(accessor, path, index=None):
        key = path.original if isinstance(path, PathSpec) else path
        if key not in files:
            raise FileNotFoundError(key)
        yield files[key]

    return read_bytes, read_stream


async def _drain(stdout) -> bytes:
    if stdout is None:
        return b""
    if isinstance(stdout, bytes):
        return stdout
    return b"".join([c async for c in stdout])


@pytest.mark.asyncio
async def test_awk_stdin_print_field():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print $1}", ),
        read_bytes=rb,
        read_stream=rs,
        stdin=b"alpha beta\ngamma delta\n",
    )
    decoded = (await _drain(output)).decode()
    assert "alpha" in decoded
    assert "gamma" in decoded
    assert "beta" not in decoded


@pytest.mark.asyncio
async def test_awk_field_separator():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print $2}", ),
        read_bytes=rb,
        read_stream=rs,
        stdin=b"a,b,c\nd,e,f\n",
        field_separator=",",
    )
    decoded = (await _drain(output)).decode()
    assert "b" in decoded
    assert "e" in decoded


@pytest.mark.asyncio
async def test_awk_variable_assignment():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print x}", ),
        read_bytes=rb,
        read_stream=rs,
        stdin=b"line\n",
        variable_assignment="x=hello",
    )
    decoded = (await _drain(output)).decode()
    assert "hello" in decoded


@pytest.mark.asyncio
async def test_awk_numeric_comparison():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("$1 > 2 {print $1}", ),
        read_bytes=rb,
        read_stream=rs,
        stdin=b"1\n2\n3\n4\n",
    )
    decoded = (await _drain(output)).decode().split()
    assert "1" not in decoded
    assert "2" not in decoded
    assert "3" in decoded
    assert "4" in decoded


@pytest.mark.asyncio
async def test_awk_regex_condition():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("/foo/ {print $0}", ),
        read_bytes=rb,
        read_stream=rs,
        stdin=b"foo bar\nbaz\nfoobar\n",
    )
    decoded = (await _drain(output)).decode()
    assert "foo bar" in decoded
    assert "foobar" in decoded
    assert "baz" not in decoded


@pytest.mark.asyncio
async def test_awk_end_block_accumulator():
    """sum += $1 with END {print sum} should emit total."""
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{sum += $1} END {print sum}", ),
        read_bytes=rb,
        read_stream=rs,
        stdin=b"10\n20\n30\n",
    )
    decoded = (await _drain(output)).decode()
    assert "60" in decoded


@pytest.mark.asyncio
async def test_awk_reads_from_file():
    rb, rs = _make_backend({"/data.txt": b"hello world\n"})
    output, io = await awk(
        [_spec("/data.txt")],
        ("{print $2}", ),
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain(output)).decode()
    assert "world" in decoded
    assert io.cache == ["/data.txt"]


@pytest.mark.asyncio
async def test_awk_program_file_overrides_inline():
    rb, rs = _make_backend({
        "/prog.awk": b"{print $1}\n",
        "/data.txt": b"alpha beta\n",
    })
    output, _ = await awk(
        [_spec("/data.txt")],
        (),
        read_bytes=rb,
        read_stream=rs,
        program_file=_spec("/prog.awk"),
    )
    decoded = (await _drain(output)).decode()
    assert "alpha" in decoded
    assert "beta" not in decoded


@pytest.mark.asyncio
async def test_awk_missing_program_raises():
    rb, rs = _make_backend({})
    with pytest.raises(ValueError, match="usage"):
        await awk([], (), read_bytes=rb, read_stream=rs)
