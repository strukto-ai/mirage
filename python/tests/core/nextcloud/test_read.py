import pytest

from mirage.core.nextcloud.read import read
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_read_bytes_whole_file(make_acc):
    acc = make_acc({"greet.txt": b"hello world"})
    out = await read(acc, PathSpec.from_str_path("/greet.txt"))
    assert out == b"hello world"


@pytest.mark.asyncio
async def test_read_bytes_offset_size_returns_slice(make_acc):
    acc = make_acc({"x": b"abcdef"})
    out = await read(acc, PathSpec.from_str_path("/x"), offset=2, size=4)
    assert out == b"cdef"


@pytest.mark.asyncio
async def test_read_bytes_offset_only(make_acc):
    acc = make_acc({"x": b"abcdef"})
    out = await read(acc, PathSpec.from_str_path("/x"), offset=3)
    assert out == b"def"


@pytest.mark.asyncio
async def test_read_bytes_missing_raises_filenotfound(make_acc):
    acc = make_acc({})
    with pytest.raises(FileNotFoundError):
        await read(acc, PathSpec.from_str_path("/nope"))


@pytest.mark.asyncio
async def test_read_records_the_virtual_path(make_acc):
    # A key named like its mount: neither m/k.txt nor /m/k.txt is virtual.
    acc = make_acc({"m/k.txt": b"hello"})
    spec = PathSpec(
        virtual="/m/m/k.txt", directory="/m/m/", vfs_path="m/k.txt"
    )
    scope = RecordingScope()
    try:
        out = await read(acc, spec)
    finally:
        scope.close()
    assert out == b"hello"
    assert [r.path for r in scope.records] == ["/m/m/k.txt"]
