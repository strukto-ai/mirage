import pytest

from mirage.core.nextcloud.read import read_bytes
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_read_bytes_whole_file(make_acc):
    acc = make_acc({"greet.txt": b"hello world"})
    out = await read_bytes(acc, PathSpec.from_str_path("/greet.txt"))
    assert out == b"hello world"


@pytest.mark.asyncio
async def test_read_bytes_offset_size_returns_slice(make_acc):
    acc = make_acc({"x": b"abcdef"})
    out = await read_bytes(acc, PathSpec.from_str_path("/x"), offset=2, size=4)
    assert out == b"cdef"


@pytest.mark.asyncio
async def test_read_bytes_offset_only(make_acc):
    acc = make_acc({"x": b"abcdef"})
    out = await read_bytes(acc, PathSpec.from_str_path("/x"), offset=3)
    assert out == b"def"


@pytest.mark.asyncio
async def test_read_bytes_missing_raises_filenotfound(make_acc):
    acc = make_acc({})
    with pytest.raises(FileNotFoundError):
        await read_bytes(acc, PathSpec.from_str_path("/nope"))
