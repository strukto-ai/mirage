import hashlib

import pytest

from mirage.commands.builtin.generic.cmp import cmp_cmd
from mirage.commands.builtin.generic.md5 import md5
from mirage.commands.builtin.generic.sha256sum import sha256sum
from mirage.types import PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(original=path, directory=path, resolved=True)


def _make_backend(files: dict[str, bytes]):

    async def read_bytes(accessor, path, index=None):
        key = path.original if isinstance(path, PathSpec) else path
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
async def test_md5_single_file():
    rb, _ = _make_backend({"/a.txt": b"hello\n"})
    output, _ = await md5([_spec("/a.txt")], read_bytes=rb)
    decoded = output.decode()
    expected = hashlib.md5(b"hello\n").hexdigest()
    assert expected in decoded
    assert "/a.txt" in decoded


@pytest.mark.asyncio
async def test_md5_multi_file_emits_one_line_each():
    rb, _ = _make_backend({"/a.txt": b"a", "/b.txt": b"b"})
    output, _ = await md5([_spec("/a.txt"), _spec("/b.txt")], read_bytes=rb)
    lines = output.decode().splitlines()
    assert len(lines) == 2


@pytest.mark.asyncio
async def test_md5_no_paths_raises():
    rb, _ = _make_backend({})
    with pytest.raises(ValueError, match="missing operand"):
        await md5([], read_bytes=rb)


@pytest.mark.asyncio
async def test_sha256sum_stdin():
    rb, rs = _make_backend({})
    output, _ = await sha256sum([],
                                read_bytes=rb,
                                read_stream=rs,
                                stdin=b"hello\n")
    decoded = (await _drain(output)).decode()
    expected = hashlib.sha256(b"hello\n").hexdigest()
    assert expected in decoded
    assert decoded.strip().endswith("-")


@pytest.mark.asyncio
async def test_sha256sum_multi_file():
    rb, rs = _make_backend({"/a.txt": b"foo", "/b.txt": b"bar"})
    output, _ = await sha256sum(
        [_spec("/a.txt"), _spec("/b.txt")], read_bytes=rb, read_stream=rs)
    decoded = (await _drain(output)).decode().splitlines()
    assert len(decoded) == 2
    assert hashlib.sha256(b"foo").hexdigest() in decoded[0]
    assert hashlib.sha256(b"bar").hexdigest() in decoded[1]


@pytest.mark.asyncio
async def test_sha256sum_check_passing():
    payload = b"hello"
    digest = hashlib.sha256(payload).hexdigest()
    manifest = f"{digest}  /file.txt\n".encode()
    rb, rs = _make_backend({
        "/manifest.sha256": manifest,
        "/file.txt": payload,
    })
    output, io = await sha256sum([_spec("/manifest.sha256")],
                                 read_bytes=rb,
                                 read_stream=rs,
                                 check=True)
    assert b"/file.txt: OK" in await _drain(output)
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_sha256sum_check_failing():
    manifest = b"deadbeef  /file.txt\n"
    rb, rs = _make_backend({
        "/manifest.sha256": manifest,
        "/file.txt": b"actual content",
    })
    output, io = await sha256sum([_spec("/manifest.sha256")],
                                 read_bytes=rb,
                                 read_stream=rs,
                                 check=True)
    assert b"/file.txt: FAILED" in await _drain(output)
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_cmp_identical_returns_nothing():
    rb, _ = _make_backend({"/a.txt": b"same", "/b.txt": b"same"})
    output, io = await cmp_cmd(
        [_spec("/a.txt"), _spec("/b.txt")], read_bytes=rb)
    assert output is None
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_cmp_differing_reports_first_byte():
    rb, _ = _make_backend({"/a.txt": b"hello", "/b.txt": b"hallo"})
    output, io = await cmp_cmd(
        [_spec("/a.txt"), _spec("/b.txt")], read_bytes=rb)
    assert output == b"/a.txt /b.txt differ: char 2, line 1\n"
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_cmp_silent_mode():
    rb, _ = _make_backend({"/a.txt": b"x", "/b.txt": b"y"})
    output, io = await cmp_cmd(
        [_spec("/a.txt"), _spec("/b.txt")], read_bytes=rb, silent=True)
    assert output is None
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_cmp_verbose_lists_all_diffs():
    rb, _ = _make_backend({"/a.txt": b"abc", "/b.txt": b"axc"})
    output, io = await cmp_cmd(
        [_spec("/a.txt"), _spec("/b.txt")], read_bytes=rb, verbose=True)
    assert b"2 142 170" in output
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_cmp_skip_offset():
    rb, _ = _make_backend({"/a.txt": b"xxhello", "/b.txt": b"yyhello"})
    output, io = await cmp_cmd(
        [_spec("/a.txt"), _spec("/b.txt")], read_bytes=rb, skip=2)
    assert output is None
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_cmp_requires_two_paths():
    rb, _ = _make_backend({"/a.txt": b"x"})
    with pytest.raises(ValueError, match="two paths"):
        await cmp_cmd([_spec("/a.txt")], read_bytes=rb)


@pytest.mark.asyncio
async def test_cmp_eof_on_shorter():
    rb, _ = _make_backend({"/a.txt": b"abc", "/b.txt": b"abcdef"})
    output, io = await cmp_cmd(
        [_spec("/a.txt"), _spec("/b.txt")], read_bytes=rb)
    assert output == b"cmp: EOF on /a.txt\n"
    assert io.exit_code == 1
