import pytest

from mirage.core.nextcloud.du import entries
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_entries_returns_per_file_with_total(make_acc):
    acc = make_acc({
        "data/a.json": b"12345",
        "data/b.json": b"67",
    })
    found, total = await entries(acc, PathSpec.from_str_path("/data"))
    assert total == 7
    assert found == [("/data/a.json", 5), ("/data/b.json", 2)]


@pytest.mark.asyncio
async def test_entries_of_file_is_empty(make_acc):
    acc = make_acc({"data/a.json": b"12345"})
    assert await entries(acc,
                         PathSpec.from_str_path("/data/a.json")) == ([], 5)
