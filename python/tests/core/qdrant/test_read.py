import json

import pytest

from mirage.core.qdrant.read import read
from mirage.types import PathSpec


def _ps(path: str) -> PathSpec:
    return PathSpec(original=path, directory=path)


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
