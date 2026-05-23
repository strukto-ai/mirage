import pytest

from mirage.commands.builtin.generic.cut import cut
from mirage.commands.builtin.generic.file import file_cmd
from mirage.commands.builtin.generic.stat import stat as generic_stat
from mirage.types import FileStat, FileType, PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(original=path, directory=path, resolved=True)


def _make_cut_backend(files: dict[str, bytes]):
    store = dict(files)

    async def read_stream(accessor, path, index=None):
        key = path.original if isinstance(path, PathSpec) else path
        if key not in store:
            raise FileNotFoundError(key)
        yield store[key]

    return read_stream, store


async def _collect(src) -> bytes:
    if isinstance(src, bytes):
        return src
    chunks = b""
    async for chunk in src:
        chunks += chunk
    return chunks


@pytest.mark.asyncio
async def test_cut_fields_default_delim():
    rs, _ = _make_cut_backend({"f.tsv": b"a\tb\tc\nd\te\tf\n"})
    src, _ = await cut([_spec("f.tsv")], read_stream=rs, f="1,3")
    out = await _collect(src)
    assert out == b"a\tc\nd\tf\n"


@pytest.mark.asyncio
async def test_cut_fields_custom_delim():
    rs, _ = _make_cut_backend({"f.csv": b"a,b,c\nd,e,f\n"})
    src, _ = await cut([_spec("f.csv")], read_stream=rs, f="2", d=",")
    out = await _collect(src)
    assert out == b"b\ne\n"


@pytest.mark.asyncio
async def test_cut_chars_range():
    rs, _ = _make_cut_backend({"f.txt": b"hello\nworld\n"})
    src, _ = await cut([_spec("f.txt")], read_stream=rs, c="1-3")
    out = await _collect(src)
    assert out == b"hel\nwor\n"


@pytest.mark.asyncio
async def test_cut_complement_fields():
    rs, _ = _make_cut_backend({"f.tsv": b"a\tb\tc\n"})
    src, _ = await cut([_spec("f.tsv")],
                       read_stream=rs,
                       f="2",
                       complement=True)
    out = await _collect(src)
    assert out == b"a\tc\n"


@pytest.mark.asyncio
async def test_cut_zero_terminated():
    rs, _ = _make_cut_backend({"f.bin": b"a\tb\x00c\td\x00"})
    src, _ = await cut([_spec("f.bin")], read_stream=rs, f="1", z=True)
    out = await _collect(src)
    assert out == b"a\x00c\x00"


@pytest.mark.asyncio
async def test_cut_stdin():
    rs, _ = _make_cut_backend({})
    src, _ = await cut([], read_stream=rs, stdin=b"x\ty\tz\n", f="2")
    out = await _collect(src)
    assert out == b"y\n"


@pytest.mark.asyncio
async def test_cut_missing_operand():
    rs, _ = _make_cut_backend({})
    with pytest.raises(ValueError, match="missing operand"):
        await cut([], read_stream=rs, f="1")


@pytest.mark.asyncio
async def test_stat_default_format():

    async def stat_fn(accessor, path, index=None):
        return FileStat(name=path.original,
                        size=42,
                        modified="2026-01-01",
                        type=FileType.TEXT)

    out, _ = await generic_stat([_spec("a.txt")], stat_fn=stat_fn)
    assert b"name=a.txt" in out
    assert b"size=42" in out
    assert b"type=text" in out


@pytest.mark.asyncio
async def test_stat_custom_format():

    async def stat_fn(accessor, path, index=None):
        return FileStat(name="foo", size=10, type=FileType.TEXT)

    out, _ = await generic_stat([_spec("foo")], stat_fn=stat_fn, c="%n=%s")
    assert out == b"foo=10"


@pytest.mark.asyncio
async def test_stat_format_F_directory():

    async def stat_fn(accessor, path, index=None):
        return FileStat(name="d", type=FileType.DIRECTORY)

    out, _ = await generic_stat([_spec("d")], stat_fn=stat_fn, c="%F")
    assert out == b"directory"


@pytest.mark.asyncio
async def test_stat_format_F_regular():

    async def stat_fn(accessor, path, index=None):
        return FileStat(name="x", type=FileType.JSON)

    out, _ = await generic_stat([_spec("x")], stat_fn=stat_fn, f="%F")
    assert out == b"regular file"


@pytest.mark.asyncio
async def test_stat_multiple_paths():

    async def stat_fn(accessor, path, index=None):
        return FileStat(name=path.original, size=1, type=FileType.TEXT)

    out, _ = await generic_stat([_spec("a"), _spec("b")],
                                stat_fn=stat_fn,
                                c="%n")
    assert out == b"a\nb"


@pytest.mark.asyncio
async def test_stat_missing_operand():

    async def stat_fn(accessor, path, index=None):
        return FileStat(name="x")

    with pytest.raises(ValueError, match="missing operand"):
        await generic_stat([], stat_fn=stat_fn)


@pytest.mark.asyncio
async def test_file_text_default():

    async def stat_fn(accessor, path):
        return FileStat(name=path.original, size=5, type=FileType.TEXT)

    async def read_bytes(accessor, path):
        return b"hello"

    out, _ = await file_cmd([_spec("a.txt")],
                            read_bytes=read_bytes,
                            stat_fn=stat_fn)
    assert b"a.txt:" in out
    assert b"text" in out


@pytest.mark.asyncio
async def test_file_brief_mode():

    async def stat_fn(accessor, path):
        return FileStat(name="f", size=4, type=FileType.TEXT)

    async def read_bytes(accessor, path):
        return b"abcd"

    out, _ = await file_cmd([_spec("f")],
                            read_bytes=read_bytes,
                            stat_fn=stat_fn,
                            b=True)
    assert b":" not in out


@pytest.mark.asyncio
async def test_file_mime_mode():

    async def stat_fn(accessor, path):
        return FileStat(name="f.json", size=10, type=FileType.JSON)

    async def read_bytes(accessor, path):
        return b'{"a": 1}'

    out, _ = await file_cmd([_spec("f.json")],
                            read_bytes=read_bytes,
                            stat_fn=stat_fn,
                            i=True)
    assert b"application/json" in out


@pytest.mark.asyncio
async def test_file_directory():

    async def stat_fn(accessor, path):
        return FileStat(name="d", type=FileType.DIRECTORY)

    async def read_bytes(accessor, path):
        raise AssertionError("should not be read for directory")

    out, _ = await file_cmd([_spec("d")],
                            read_bytes=read_bytes,
                            stat_fn=stat_fn)
    assert b"d: directory" == out


@pytest.mark.asyncio
async def test_file_multiple_paths():

    async def stat_fn(accessor, path):
        return FileStat(name=path.original, size=3, type=FileType.TEXT)

    async def read_bytes(accessor, path):
        return b"abc"

    out, _ = await file_cmd([_spec("a"), _spec("b")],
                            read_bytes=read_bytes,
                            stat_fn=stat_fn)
    assert b"a:" in out
    assert b"b:" in out
    assert out.count(b"\n") == 1


@pytest.mark.asyncio
async def test_file_read_error_logs_and_falls_back():

    async def stat_fn(accessor, path):
        return FileStat(name="x", size=1, type=FileType.TEXT)

    async def read_bytes(accessor, path):
        raise OSError("denied")

    out, _ = await file_cmd([_spec("x")],
                            read_bytes=read_bytes,
                            stat_fn=stat_fn)
    assert b"x:" in out


@pytest.mark.asyncio
async def test_file_missing_operand():

    async def stat_fn(accessor, path):
        return FileStat(name="x")

    async def read_bytes(accessor, path):
        return b""

    with pytest.raises(ValueError, match="missing operand"):
        await file_cmd([], read_bytes=read_bytes, stat_fn=stat_fn)
