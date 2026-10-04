from collections.abc import AsyncIterator

import pytest

from mirage.core.awk.reader import RecordReader
from mirage.shell.bytes import byte_view


async def pieces(*parts: bytes) -> AsyncIterator[bytes]:
    for part in parts:
        yield part


async def records(reader: RecordReader) -> list[str]:
    out: list[str] = []
    while (record := await reader.next()) is not None:
        out.append(record)
    return out


@pytest.mark.asyncio
async def test_records_span_chunk_boundaries():
    reader = RecordReader(pieces(b"a\nb", b"c\n", b"d"), lambda: "\n")
    assert await records(reader) == ["a", "bc", "d"]
    assert await reader.next() is None


@pytest.mark.asyncio
async def test_multibyte_bytes_survive_chunk_boundaries():
    data = "é\n".encode()
    reader = RecordReader(pieces(data[:1], data[1:]), lambda: "\n")
    assert await records(reader) == [byte_view("é")]


@pytest.mark.asyncio
async def test_rs_is_read_again_before_each_record():
    current = {"rs": "\n"}

    def rs() -> str:
        return current["rs"]

    reader = RecordReader(b"a\nb\nc\n\nd\n", rs)
    assert await reader.next() == "a"
    current["rs"] = ""
    assert await records(reader) == ["b\nc", "d"]


@pytest.mark.asyncio
async def test_regex_and_bytes_sources():
    reader = RecordReader(b"a1b22c", lambda: "[0-9]+")
    assert await records(reader) == ["a", "b", "c"]


@pytest.mark.asyncio
async def test_close_stops_pulling():
    pulled: list[bytes] = []

    async def source() -> AsyncIterator[bytes]:
        for part in (b"a\n", b"b\n"):
            pulled.append(part)
            yield part

    reader = RecordReader(source(), lambda: "\n")
    assert await reader.next() == "a"
    await reader.close()
    assert pulled == [b"a\n"]
