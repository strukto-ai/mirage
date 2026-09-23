import json

import pytest

from mirage.core.qdrant.read import read
from mirage.types import PathSpec


def _ps(path: str) -> PathSpec:
    return PathSpec(virtual=path, directory=path, vfs_path=path.strip("/"))


@pytest.mark.asyncio
async def test_read_json_returns_payload(accessor):
    data = (await read(accessor, _ps("/animals/cat/big/1.json"))).decode()
    payload = json.loads(data)
    assert payload["label"] == "cat"
    assert payload["name"] == "a big orange cat"
    assert payload["id"] == 1
    assert "vector" not in payload
    assert "image_bytes" not in payload


@pytest.mark.asyncio
async def test_read_text_returns_source_text(accessor):
    data = (await read(accessor, _ps("/animals/cat/big/1.txt"))).decode()
    assert data == "a big orange cat\n"


@pytest.mark.asyncio
async def test_read_blob_returns_raw_bytes(accessor):
    data = await read(accessor, _ps("/animals/cat/big/1.png"))
    assert data == b"PNG-1"


@pytest.mark.asyncio
async def test_read_missing_row_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await read(accessor, _ps("/animals/cat/big/999.json"))


@pytest.mark.asyncio
async def test_read_named_chunk_with_nested_text_field(lineage):
    data = await read(lineage, _ps("/refund-2026.pdf/004__1.txt"))
    assert data == b"Refunds are processed within 14 days\n"


@pytest.mark.asyncio
async def test_read_rejects_a_stem_the_listing_never_published(lineage):
    # The label is stripped before the retrieve, so any spelling that ends
    # in __<id> fetches the point; only the stem readdir publishes opens.
    with pytest.raises(FileNotFoundError):
        await read(lineage, _ps("/refund-2026.pdf/wrong__1.txt"))
    with pytest.raises(FileNotFoundError):
        await read(lineage, _ps("/refund-2026.pdf/1.txt"))


@pytest.mark.asyncio
async def test_read_rejects_an_alias_of_the_point_id(accessor):
    with pytest.raises(FileNotFoundError):
        await read(accessor, _ps("/animals/cat/big/01.json"))
