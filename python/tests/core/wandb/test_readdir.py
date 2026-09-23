from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

from mirage.accessor.wandb import WandbAccessor
from mirage.cache.index import RAMIndexCacheStore
from mirage.core.wandb.config import WandbConfig
from mirage.core.wandb.errors import WandbAPIError
from mirage.core.wandb.readdir import file_entries, readdir
from mirage.core.wandb.stat import stat
from mirage.types import FileType, PathSpec


@pytest.mark.parametrize("name",
                         ["../escape", "/absolute", "a//b", "a/./b", "a\\b"])
def test_unsafe_file_names_fail(name: str) -> None:
    with pytest.raises(WandbAPIError, match="unsafe"):
        file_entries([{"name": name, "sizeBytes": 1}], "")


def test_file_directory_collision_fails() -> None:
    with pytest.raises(WandbAPIError, match="collision"):
        file_entries([{
            "name": "a",
            "sizeBytes": 1
        }, {
            "name": "a/b",
            "sizeBytes": 2
        }], "")


def path(key: str) -> PathSpec:
    return PathSpec.from_str_path("/wandb/" + key, vfs_path=key)


@pytest.mark.asyncio
async def test_nested_catalog_reuse_and_expiry() -> None:
    accessor = WandbAccessor(WandbConfig(entities=["lab"]))
    accessor.client.run = AsyncMock(return_value={"name": "run"})
    files = AsyncMock(side_effect=[
        [{
            "name": "nested/old.txt",
            "sizeBytes": 3
        }, {
            "name": "deep/sub/file.txt",
            "sizeBytes": 5
        }],
        [{
            "name": "nested/new.txt",
            "sizeBytes": 9
        }],
    ])
    accessor.client.files = files
    index = RAMIndexCacheStore()
    root = "lab/project/run/files"
    await readdir(accessor, path("lab/project/run"), index)
    await readdir(accessor, path(root), index)
    assert await readdir(accessor, path(root + "/deep/sub"),
                         index) == ["/wandb/" + root + "/deep/sub/file.txt"]
    assert (await stat(accessor, path(root), index)).type == FileType.DIRECTORY
    assert (await stat(accessor, path(root + "/nested/old.txt"),
                       index)).size == 3
    assert files.call_count == 1
    # get() retains entries after expiry; stat must check the parent listing.
    await index.set_dir("/wandb/" + root + "/nested", [],
                        expired_at=datetime.now(timezone.utc) -
                        timedelta(seconds=1))
    with pytest.raises(FileNotFoundError):
        await stat(accessor, path(root + "/nested/old.txt"), index)
    assert (await stat(accessor, path(root + "/nested/new.txt"),
                       index)).size == 9
    assert (await
            index.get("/wandb/" + root + "/deep/sub/file.txt")).entry is None
    assert files.call_count == 2


@pytest.mark.asyncio
async def test_catalog_failure_does_not_publish_partial_listing() -> None:
    accessor = WandbAccessor(WandbConfig(entities=["lab"]))
    accessor.client.files = AsyncMock(return_value=[
        {
            "name": "nested/child",
            "sizeBytes": 3
        },
        {
            "name": "nested",
            "sizeBytes": 1
        },
    ])
    index = RAMIndexCacheStore()
    with pytest.raises(WandbAPIError, match="collision"):
        await readdir(accessor, path("lab/project/run/files"), index)
    assert await index.entries() == {}
