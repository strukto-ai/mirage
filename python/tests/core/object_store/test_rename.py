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
from dataclasses import replace

import pytest

from mirage.cache.context import push_cache_manager
from mirage.core.object_store.exists import make_exists
from mirage.core.object_store.rename import make_rename
from mirage.core.object_store.stat import make_stat
from mirage.observe.context import RecordingScope
from tests.core.object_store.conftest import (FakeManager, FakeStore,
                                              make_driver, spec)


def _rename_for(store: FakeStore):
    driver = make_driver(store)
    return make_rename(driver, make_exists(make_stat(driver)))


def _managed(coro):
    manager = FakeManager()
    prev = push_cache_manager(manager)
    try:
        asyncio.run(coro)
    finally:
        push_cache_manager(prev)
    return manager


def test_rename_moves_a_file(accessor):
    store = FakeStore({"a/src.txt": b"hi"})
    manager = _managed(
        _rename_for(store)(accessor, spec("/a/src.txt"), spec("/b/dst.txt")))
    assert store.objects == {"b/dst.txt": b"hi"}
    assert manager.subtrees == ["/b/dst.txt", "/a/src.txt"]
    assert manager.writes == ["/b", "/a"]


def test_rename_falls_back_to_the_prefix_walk(accessor):
    store = FakeStore({"dir/f.txt": b"x", "dir/sub/g.txt": b"y"})
    _managed(_rename_for(store)(accessor, spec("/dir"), spec("/moved")))
    assert store.objects == {"moved/f.txt": b"x", "moved/sub/g.txt": b"y"}


def test_rename_missing_source_is_enoent(accessor):
    store = FakeStore()
    with pytest.raises(FileNotFoundError):
        _managed(_rename_for(store)(accessor, spec("/never"), spec("/dst")))


def test_rename_onto_the_same_key_is_a_guarded_no_op(accessor):
    store = FakeStore({"a.txt": b"hi"})
    manager = _managed(
        _rename_for(store)(accessor, spec("/a.txt"), spec("/a.txt")))
    assert store.objects == {"a.txt": b"hi"}
    assert manager.unlinks == []
    assert manager.subtrees == []


def test_rename_onto_the_same_key_still_fails_when_absent(accessor):
    with pytest.raises(FileNotFoundError):
        _managed(
            _rename_for(FakeStore())(accessor, spec("/a.txt"), spec("/a.txt")))


def test_rename_without_native_move_refuses_to_build():
    driver = replace(make_driver(FakeStore()),
                     move_file=None,
                     move_prefix=None)
    with pytest.raises(ValueError, match="no native move"):
        make_rename(driver, make_exists(make_stat(driver)))


# ── the retraction records snapshot capture reads ────────────────────────


def _recorded(coro):
    scope = RecordingScope()
    try:
        _managed(coro)
    finally:
        scope.close()
    return [(r.op, r.path) for r in scope.records]


def test_rename_records_a_retraction_for_both_paths(accessor):
    """A move invalidates the token of both: src's object left, dst's was
    replaced by it. A single object moved, so the op is the point one and
    nothing under the name is retracted."""
    store = FakeStore({"a.txt": b"x"})
    assert _recorded(
        make_rename(make_driver(store),
                    _exists)(accessor, spec("/a.txt"),
                             spec("/b.txt"))) == [("rename", "/a.txt"),
                                                  ("rename", "/b.txt")]


def test_self_rename_records_nothing(accessor):
    """POSIX rename(2) of a path onto itself performs no other action."""
    store = FakeStore({"a.txt": b"x"})
    assert _recorded(
        make_rename(make_driver(store), _exists)(accessor, spec("/a.txt"),
                                                 spec("/a.txt"))) == []


async def _exists(accessor, path) -> bool:
    return True


async def _boom(conn, src_pfx: str, dst_pfx: str) -> bool:
    raise RuntimeError("boom")


def _recorded_failure(coro, exc_type, match: str | None = None):
    scope = RecordingScope()
    try:
        with pytest.raises(exc_type, match=match):
            _managed(coro)
    finally:
        scope.close()
    return [(r.op, r.path) for r in scope.records]


def test_rename_records_both_retractions_when_the_prefix_walk_fails(accessor):
    """move_file's clean False is the ordinary way into the prefix walk,
    not an answer about it. The walk is paginated and can raise having
    already moved keys, which is the case the record is in `finally`
    for."""
    store = FakeStore({"d/f.txt": b"x"})
    driver = replace(make_driver(store), move_prefix=_boom)
    assert _recorded_failure(
        make_rename(driver, _exists)(accessor, spec("/d"), spec("/e")),
        RuntimeError, "boom") == [("rename_prefix", "/d"),
                                  ("rename_prefix", "/e")]


def test_rename_evicts_both_subtrees_when_the_prefix_walk_raises(accessor):
    """The eviction rides with the records, on the same condition."""

    async def run():
        driver = replace(make_driver(FakeStore({"d/f.txt": b"x"})),
                         move_prefix=_boom)
        with pytest.raises(RuntimeError):
            await make_rename(driver, _exists)(accessor, spec("/d"),
                                               spec("/e"))

    manager = _managed(run())
    assert manager.subtrees == ["/e", "/d"]


def test_rename_of_a_missing_source_records_nothing(accessor):
    """Both calls answering a clean False is the store saying nothing
    moved at all, which is the one outcome safe to skip."""
    assert _recorded_failure(
        make_rename(make_driver(FakeStore()), _exists)(accessor,
                                                       spec("/a.txt"),
                                                       spec("/b.txt")),
        FileNotFoundError) == []
