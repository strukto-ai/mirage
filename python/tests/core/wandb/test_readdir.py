from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

from mirage.accessor.wandb import WandbAccessor
from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.index import Evicted, RAMIndexCacheStore
from mirage.cache.index.view import IndexView
from mirage.core.wandb.config import WandbConfig
from mirage.core.wandb.errors import WandbAPIError
from mirage.core.wandb.readdir import file_tree, readdir
from mirage.core.wandb.stat import stat
from mirage.types import FileType, PathSpec


@pytest.mark.parametrize(
    "name", ["../escape", "/absolute", "a//b", "a/./b", "a\\b"]
)
def test_unsafe_file_names_fail(name: str) -> None:
    with pytest.raises(WandbAPIError, match="unsafe"):
        file_tree([{"name": name, "sizeBytes": 1}])


def test_file_directory_collision_fails() -> None:
    with pytest.raises(WandbAPIError, match="collision"):
        file_tree(
            [{"name": "a", "sizeBytes": 1}, {"name": "a/b", "sizeBytes": 2}]
        )


def path(key: str) -> PathSpec:
    return PathSpec.from_str_path("/wandb/" + key, vfs_path=key)


@pytest.mark.asyncio
async def test_nested_catalog_reuse_and_expiry() -> None:
    accessor = WandbAccessor(WandbConfig(entities=["lab"]))
    accessor.client.run = AsyncMock(return_value={"name": "run"})
    files = AsyncMock(
        side_effect=[
            [
                {"name": "nested/old.txt", "sizeBytes": 3},
                {"name": "deep/sub/file.txt", "sizeBytes": 5},
            ],
            [{"name": "nested/new.txt", "sizeBytes": 9}],
        ]
    )
    accessor.client.files = files
    index = RAMIndexCacheStore()
    root = "lab/project/run/files"
    await readdir(accessor, path("lab/project/run"), index)
    await readdir(accessor, path(root), index)
    assert await readdir(accessor, path(root + "/deep/sub"), index) == [
        "/wandb/" + root + "/deep/sub/file.txt"
    ]
    assert (await stat(accessor, path(root), index)).type == FileType.DIRECTORY
    assert (
        await stat(accessor, path(root + "/nested/old.txt"), index)
    ).size == 3
    assert files.call_count == 1
    # get() retains entries after expiry; stat must check the parent listing.
    await index.set_dir(
        "/wandb/" + root + "/nested",
        [],
        expired_at=datetime.now(timezone.utc) - timedelta(seconds=1),
    )
    with pytest.raises(FileNotFoundError):
        await stat(accessor, path(root + "/nested/old.txt"), index)
    assert (
        await stat(accessor, path(root + "/nested/new.txt"), index)
    ).size == 9
    assert (
        await index.get("/wandb/" + root + "/deep/sub/file.txt")
    ).entry is None
    assert files.call_count == 2


@pytest.mark.asyncio
async def test_catalog_failure_does_not_publish_partial_listing() -> None:
    accessor = WandbAccessor(WandbConfig(entities=["lab"]))
    accessor.client.files = AsyncMock(
        return_value=[
            {"name": "nested/child", "sizeBytes": 3},
            {"name": "nested", "sizeBytes": 1},
        ]
    )
    index = RAMIndexCacheStore()
    with pytest.raises(WandbAPIError, match="collision"):
        await readdir(accessor, path("lab/project/run/files"), index)
    assert await index.entries() == {}


@pytest.mark.asyncio
async def test_a_file_relist_hands_what_it_dropped_to_cleanup() -> None:
    # The catalog is one complete fetch, so a re-list that no longer names
    # a file or a folder is the backend saying it went away.
    gone: list[Evicted] = []

    async def on_gone(children: list[Evicted]) -> None:
        gone.extend(children)

    accessor = WandbAccessor(WandbConfig(entities=["lab"]))
    accessor.client.run = AsyncMock(return_value={"name": "run"})
    accessor.client.files = AsyncMock(
        side_effect=[
            [
                {"name": "nested/old.txt", "sizeBytes": 3},
                {"name": "deep/sub/file.txt", "sizeBytes": 5},
            ],
            [{"name": "nested/new.txt", "sizeBytes": 9}],
        ]
    )
    store = RAMIndexCacheStore()
    index = IndexView(
        store,
        RAMFileCacheStore(),
        "/wandb",
        lambda _key: True,
        on_gone=on_gone,
    )
    root = "lab/project/run/files"
    await readdir(accessor, path(root), index)
    await store.invalidate()
    await readdir(accessor, path(root), index)
    assert sorted(child.path for child in gone) == [
        "/wandb/" + root + "/deep",
        "/wandb/" + root + "/nested/old.txt",
    ]
