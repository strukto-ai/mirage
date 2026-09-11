# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import asyncio
import errno
from dataclasses import replace

import pytest

from mirage.cache.context import push_cache_manager
from mirage.core.object_store.remove import (make_remove_prefix, make_rmdir,
                                             make_unlink)
from tests.core.object_store.conftest import (FakeManager, FakeStore,
                                              make_driver, spec)


def _managed(coro):
    manager = FakeManager()
    prev = push_cache_manager(manager)
    try:
        asyncio.run(coro)
    finally:
        push_cache_manager(prev)
    return manager


def test_unlink_deletes_and_invalidates_every_ancestor_listing(accessor):
    # Deleting the last key under a/b makes /a/b and /a disappear as
    # implied prefixes; the stale-ancestor eviction is the pinned fix.
    store = FakeStore({"a/b/c.txt": b"hi"})
    manager = _managed(
        make_unlink(make_driver(store))(accessor, spec("/a/b/c.txt")))
    assert store.objects == {}
    assert manager.unlinks == ["/a/b/c.txt"]
    assert manager.writes == ["/a/b", "/a"]


def test_remove_prefix_deletes_the_subtree_and_ancestors_evict(accessor):
    store = FakeStore({"a/b/c.txt": b"hi", "a/b/d/e.txt": b"x"})
    manager = _managed(
        make_remove_prefix(make_driver(store))(accessor, spec("/a/b")))
    assert store.objects == {}
    # A subtree evict, not an unlink: every key below /a/b went with it,
    # and each one was cached under its own key.
    assert manager.subtrees == ["/a/b"]
    assert manager.unlinks == []
    assert manager.writes == ["/a"]


def test_rmdir_refuses_a_nonempty_prefix_and_keeps_every_key(accessor):
    """rmdir is not make_remove_prefix.

    On a keyed store an empty directory is its marker object, so a prefix
    delete removes an empty directory correctly and a non-empty one
    recursively -- which is ``rm -r``. The two slots shared one function,
    so every caller that does not pre-check emptiness itself (FUSE,
    ``ws.fs``, the sandbox runtimes) destroyed the subtree.
    """
    store = FakeStore({"a/b/": b"", "a/b/c.txt": b"hi", "a/b/d/e.txt": b"x"})
    with pytest.raises(OSError) as excinfo:
        _managed(make_rmdir(make_driver(store))(accessor, spec("/a/b")))
    assert excinfo.value.errno == errno.ENOTEMPTY
    assert store.objects == {
        "a/b/": b"",
        "a/b/c.txt": b"hi",
        "a/b/d/e.txt": b"x",
    }


def test_rmdir_refuses_a_prefix_whose_only_child_is_a_subdirectory(accessor):
    store = FakeStore({"a/b/": b"", "a/b/d/": b""})
    with pytest.raises(OSError) as excinfo:
        _managed(make_rmdir(make_driver(store))(accessor, spec("/a/b")))
    assert excinfo.value.errno == errno.ENOTEMPTY
    assert store.objects == {"a/b/": b"", "a/b/d/": b""}


def test_rmdir_removes_the_marker_of_an_empty_prefix(accessor):
    store = FakeStore({"a/b/": b"", "keep.txt": b"k"})
    manager = _managed(make_rmdir(make_driver(store))(accessor, spec("/a/b")))
    assert store.objects == {"keep.txt": b"k"}
    assert manager.unlinks == ["/a/b"]
    assert manager.writes == ["/a"]


def test_rmdir_reports_enoent_for_a_prefix_holding_no_key(accessor):
    store = FakeStore({"keep.txt": b"k"})
    with pytest.raises(FileNotFoundError):
        _managed(make_rmdir(make_driver(store))(accessor, spec("/a/b")))
    assert store.objects == {"keep.txt": b"k"}


def test_rmdir_on_a_populated_mount_root_destroys_nothing(accessor):
    """The whole-store case, which the shared prefix delete got wrong.

    A mount root resolves to the bare key prefix, so ``make_remove_prefix``
    in this slot emptied the entire store. ``MountRootPolicy`` refuses a
    mount root as an operand with EBUSY, but only on the command path;
    FUSE and ``ws.fs`` reach the op. The root is also the one path that
    cannot report ENOENT -- it exists because it is mounted -- so the
    empty case below is a no-op rather than a refusal.
    """
    store = FakeStore({"a.txt": b"x", "d/f.txt": b"y"})
    with pytest.raises(OSError) as excinfo:
        _managed(make_rmdir(make_driver(store))(accessor, spec("/")))
    assert excinfo.value.errno == errno.ENOTEMPTY
    assert store.objects == {"a.txt": b"x", "d/f.txt": b"y"}


def test_rmdir_on_an_empty_mount_root_is_a_no_op(accessor):
    store = FakeStore({})
    _managed(make_rmdir(make_driver(store))(accessor, spec("/")))
    assert store.objects == {}


def test_rmdir_leaves_a_child_that_arrived_after_the_probe(accessor):
    """The delete is the marker, not the prefix.

    A concurrent writer can create a child between the emptiness listing
    and the delete, and a prefix delete would take that child down with
    it -- the subtree loss this function exists to stop, in a smaller
    window. So rmdir deletes only the one key that spells "empty
    directory", which nothing arriving after the probe can widen.
    """
    store = FakeStore({"a/b/": b""})
    driver = make_driver(store)

    async def racing_children(conn, pfx):
        async for child in driver.list_children(conn, pfx):
            yield child
        conn.objects["a/b/late.txt"] = b"new"

    rmdir = make_rmdir(replace(driver, list_children=racing_children))
    _managed(rmdir(accessor, spec("/a/b")))
    assert store.objects == {"a/b/late.txt": b"new"}
    assert store.deletes == ["a/b/"]
