import asyncio

import pytest

from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.manager import CacheManager
from mirage.types import FileChangeKind, PathSpec
from mirage.utils.key_prefix import (mount_key, mount_prefix_of, strip_mount,
                                     under_path)
from mirage.watch.events import event_at, virtual_of
from mirage.watch.watcher import Watcher

# Mount/child pairs where the child's name begins with the mount prefix's
# own characters. Naive `startswith` arithmetic reads the child as already
# mount-absolute and skips the prefix, so every derived key lands one level
# too high -- and a cache eviction that hits no key is silent, which is why
# this class of bug survives until a test happens to name a directory badly.
CASES = [
    ("/d", "day"),
    ("/d", "d"),
    ("/data", "database"),
    ("/a", "ab"),
    ("/ab", "abc"),
    ("/x", "xyz/deep"),
]


class _Entry:

    def __init__(self, prefix: str, manager: CacheManager) -> None:
        self.prefix = prefix
        self.cache_manager = manager


class _Registry:

    def __init__(self, entry: _Entry) -> None:
        self._entry = entry

    def mount_for(self, path: str) -> _Entry:
        return self._entry


def _run(coro):
    return asyncio.run(coro)


def _spec(mount: str, child: str) -> PathSpec:
    return PathSpec(virtual=f"{mount}/{child}",
                    directory=f"{mount}/{child}",
                    vfs_path=child)


@pytest.mark.parametrize("mount,child", CASES)
def test_mount_prefix_round_trips(mount, child):
    virtual = f"{mount}/{child}"
    assert mount_prefix_of(virtual, child) == mount
    assert mount_key(virtual, mount) == child
    assert strip_mount(virtual, mount) == f"/{child}"


@pytest.mark.parametrize("mount,child", CASES)
def test_a_child_is_under_its_mount(mount, child):
    assert under_path(f"{mount}/{child}", mount) is True


@pytest.mark.parametrize("mount,child",
                         [c for c in CASES if f"/{c[1]}" != c[0]])
def test_a_lookalike_sibling_is_not_under_the_mount(mount, child):
    # Excludes the pair where the child's own name spells the mount
    # itself ("/d" holding "d"): there "/d" is the mount root, not a
    # sibling, so it is legitimately under it.
    assert under_path(f"/{child}", mount) is False


@pytest.mark.parametrize("mount,child", CASES)
def test_event_helpers_lift_onto_the_mount(mount, child):
    root = PathSpec(virtual=mount, directory=mount, vfs_path="")
    assert virtual_of(root, child) == f"{mount}/{child}"
    event = event_at(root, child, FileChangeKind.CREATE)
    assert event.path.virtual == f"{mount}/{child}"
    assert event.path.vfs_path == child


async def _evicted(mount: str, child: str, kind: FileChangeKind) -> bool:
    """Whether the listing at ``mount/child`` was actually dropped."""
    cache, index = RAMFileCacheStore(), RAMIndexCacheStore(ttl=600)
    entry = IndexEntry(id="1", name="f", resource_type="file")
    await index.set_dir(f"{mount}/{child}", [("leaf.txt", entry)])
    manager = CacheManager(cache, index, f"{mount}/", True)
    path = _spec(mount, child)
    if kind is FileChangeKind.DELETE:
        await manager.invalidate_after_unlink(path)
    elif kind is FileChangeKind.UNKNOWN:
        await manager.invalidate_subtree(path)
    else:
        await manager.invalidate_after_write(path)
    return (await index.list_dir(f"{mount}/{child}")).entries is None


@pytest.mark.parametrize("mount,child", CASES)
@pytest.mark.parametrize("kind",
                         [FileChangeKind.DELETE, FileChangeKind.UNKNOWN])
def test_evictions_that_drop_a_listing_reach_the_real_key(mount, child, kind):
    assert _run(_evicted(mount, child, kind)) is True


async def _parent_evicted(mount: str, child: str) -> bool:
    """Whether a write under ``mount/child`` dropped that directory."""
    cache, index = RAMFileCacheStore(), RAMIndexCacheStore(ttl=600)
    entry = IndexEntry(id="1", name="f", resource_type="file")
    await index.set_dir(f"{mount}/{child}", [("leaf.txt", entry)])
    manager = CacheManager(cache, index, f"{mount}/", True)
    await manager.invalidate_after_write(
        PathSpec(virtual=f"{mount}/{child}/leaf.txt",
                 directory=f"{mount}/{child}",
                 vfs_path=f"{child}/leaf.txt"))
    return (await index.list_dir(f"{mount}/{child}")).entries is None


@pytest.mark.parametrize("mount,child", CASES)
def test_a_write_drops_the_parent_listing_at_the_real_key(mount, child):
    assert _run(_parent_evicted(mount, child)) is True


async def _subtree_evicted(mount: str, child: str) -> bool:
    """Whether UNKNOWN reached a listing nested under ``mount/child``."""
    cache, index = RAMFileCacheStore(), RAMIndexCacheStore(ttl=600)
    entry = IndexEntry(id="1", name="f", resource_type="file")
    await index.set_dir(f"{mount}/{child}/nested", [("leaf.txt", entry)])
    manager = CacheManager(cache, index, f"{mount}/", True)
    await manager.invalidate_subtree(_spec(mount, child))
    return (await index.list_dir(f"{mount}/{child}/nested")).entries is None


@pytest.mark.parametrize("mount,child", CASES)
def test_a_subtree_eviction_reaches_nested_listings(mount, child):
    assert _run(_subtree_evicted(mount, child)) is True


async def _framed(mount: str, child: str) -> PathSpec:
    cache, index = RAMFileCacheStore(), RAMIndexCacheStore(ttl=600)
    manager = CacheManager(cache, index, f"{mount}/", True)
    watcher = Watcher(_Registry(_Entry(f"{mount}/", manager)))
    return watcher._frame(_Entry(f"{mount}/", manager), f"{mount}/{child}")


@pytest.mark.parametrize("mount,child", CASES)
def test_the_watcher_frames_a_lookalike_child_correctly(mount, child):
    framed = _run(_framed(mount, child))
    assert framed.virtual == f"{mount}/{child}"
    assert framed.vfs_path == child
