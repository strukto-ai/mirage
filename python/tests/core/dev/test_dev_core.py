import pytest

from mirage.accessor.ram import RAMAccessor
from mirage.core.dev.constants import ZERO_CHUNK_SIZE
from mirage.core.dev.read import read
from mirage.core.dev.stat import stat
from mirage.core.dev.stream import read_stream
from mirage.resource.dev.dev import DevStore
from mirage.types import DEVICE_NUMBERS_KEY, ContentType, FileType, PathSpec


def _accessor():
    return RAMAccessor(DevStore())


def _spec(name: str):
    return PathSpec(resource_path=name.strip("/"),
                    virtual="/dev/" + name.strip("/"),
                    directory="/dev/" + name.strip("/"))


@pytest.mark.asyncio
@pytest.mark.parametrize("name,rdev", [("null", [1, 3]), ("zero", [1, 5])])
async def test_stat_is_char_device(name, rdev):
    s = await stat(_accessor(), _spec(name))
    assert s.type is FileType.CHAR_DEVICE
    assert s.size is None
    assert s.content is None
    assert s.extra[DEVICE_NUMBERS_KEY] == rdev


@pytest.mark.asyncio
async def test_null_reads_empty():
    a = _accessor()
    assert await read(a, _spec("null")) == b""
    assert await read(a, _spec("null"), size=100) == b""


@pytest.mark.asyncio
async def test_zero_ranged_read_is_exact():
    a = _accessor()
    assert await read(a, _spec("zero"), size=17) == b"\x00" * 17
    assert await read(a, _spec("zero"), offset=9, size=3) == b"\x00" * 3


@pytest.mark.asyncio
async def test_zero_whole_read_refuses():
    with pytest.raises(OSError):
        await read(_accessor(), _spec("zero"))


@pytest.mark.asyncio
async def test_zero_stream_is_endless_and_stops_when_the_reader_stops():
    seen = 0
    async for chunk in read_stream(_accessor(), _spec("zero")):
        assert chunk == b"\x00" * ZERO_CHUNK_SIZE
        seen += 1
        if seen == 3:
            break
    assert seen == 3


@pytest.mark.asyncio
async def test_null_stream_is_empty():
    chunks = [c async for c in read_stream(_accessor(), _spec("null"))]
    assert chunks == []


@pytest.mark.asyncio
async def test_recreated_device_is_a_regular_file():
    a = _accessor()
    a.store.files.__delitem__("/null")  # rm /dev/null (tombstone)
    a.store.files["/null"] = b"recreated\n"  # echo ... > /dev/null
    s = await stat(a, _spec("null"))
    assert s.type is FileType.FILE
    # "null" has no extension, so content_type_for_path falls back to BINARY.
    assert s.content is ContentType.BINARY
    assert await read(a, _spec("null")) == b"recreated\n"
