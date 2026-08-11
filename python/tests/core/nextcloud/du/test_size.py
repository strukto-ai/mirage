import pytest

from mirage.core.nextcloud.du import size
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_size_sums_file_sizes_recursive(make_acc):
    acc = make_acc({
        "data/a.json": b"12345",
        "data/sub/b.json": b"67",
        "other.txt": b"x",
    })
    total = await size(acc, PathSpec.from_str_path("/data"))
    assert total == 7


@pytest.mark.asyncio
async def test_size_missing_returns_zero(make_acc):
    acc = make_acc({})
    assert await size(acc, PathSpec.from_str_path("/nope")) == 0


@pytest.mark.asyncio
async def test_size_of_file_returns_its_own_size(make_acc):
    acc = make_acc({"data/a.json": b"12345"})
    assert await size(acc, PathSpec.from_str_path("/data/a.json")) == 5
