from unittest.mock import AsyncMock

import pytest

from mirage.accessor.wandb import WandbAccessor
from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.index import Evicted, RAMIndexCacheStore
from mirage.cache.index.view import IndexView
from mirage.core.wandb.config import WandbConfig
from mirage.core.wandb.errors import WandbAPIError
from mirage.core.wandb.readdir import file_tree, readdir
from mirage.types import PathSpec
from mirage.vfs.wandb import WandbVFS
from mirage.workspace import Workspace
from mirage.workspace.mount.listing import keep_listing
from tests.fixtures.vfs_io import vfs_over


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
async def test_one_catalog_answers_every_directory_below_files() -> None:
    accessor = WandbAccessor(WandbConfig(entities=["lab"]))
    accessor.client.run = AsyncMock(return_value={"name": "run"})
    files = AsyncMock(
        return_value=[
            {"name": "nested/old.txt", "sizeBytes": 3},
            {"name": "deep/sub/file.txt", "sizeBytes": 5},
        ]
    )
    accessor.client.files = files
    ws = Workspace({"/wandb/": vfs_over(WandbVFS, accessor)})
    root = "/wandb/lab/project/run/files"
    await ws.dispatch("readdir", PathSpec.from_str_path(root))
    listed, _ = await ws.dispatch(
        "readdir", PathSpec.from_str_path(root + "/deep/sub")
    )
    assert listed == [root + "/deep/sub/file.txt"]
    old, _ = await ws.dispatch(
        "stat", PathSpec.from_str_path(root + "/nested/old.txt")
    )
    assert old.size == 3
    assert files.call_count == 1


@pytest.mark.asyncio
async def test_catalog_failure_does_not_publish_partial_listing() -> None:
    accessor = WandbAccessor(WandbConfig(entities=["lab"]))
    accessor.client.files = AsyncMock(
        return_value=[
            {"name": "nested/child", "sizeBytes": 3},
            {"name": "nested", "sizeBytes": 1},
        ]
    )
    with pytest.raises(WandbAPIError, match="collision"):
        await readdir(accessor, path("lab/project/run/files"))


@pytest.mark.asyncio
async def test_a_file_relist_hands_what_it_dropped_to_cleanup() -> None:
    # The catalog is one complete fetch, so a re-list that no longer names
    # a file or a folder is the backend saying it went away.
    gone: list[Evicted] = []

    async def on_gone(children: list[Evicted]) -> None:
        gone.extend(children)

    accessor = WandbAccessor(WandbConfig(entities=["lab"]))
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
    key = "/wandb/" + root
    await keep_listing(index, key, await readdir(accessor, path(root)))
    await store.invalidate()
    await keep_listing(index, key, await readdir(accessor, path(root)))
    assert sorted(child.path for child in gone) == [
        "/wandb/" + root + "/deep",
        "/wandb/" + root + "/nested/old.txt",
    ]
