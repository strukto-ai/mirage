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
from mirage.core.object_store.copy import make_copy
from mirage.core.object_store.exists import make_exists
from mirage.core.object_store.stat import make_stat
from mirage.observe.context import RecordingScope
from tests.core.object_store.conftest import (FakeManager, FakeStore,
                                              make_driver, spec)


def _copy_for(store: FakeStore):
    driver = make_driver(store)
    return make_copy(driver, make_exists(make_stat(driver)))


def _managed(coro):
    manager = FakeManager()
    prev = push_cache_manager(manager)
    try:
        asyncio.run(coro)
    finally:
        push_cache_manager(prev)
    return manager


def test_copy_duplicates_and_invalidates_destination_ancestors(accessor):
    store = FakeStore({"src.txt": b"hi"})
    manager = _managed(
        _copy_for(store)(accessor, spec("/src.txt"), spec("/a/b/dst.txt")))
    assert store.objects == {"src.txt": b"hi", "a/b/dst.txt": b"hi"}
    assert manager.writes == ["/a/b/dst.txt", "/a/b", "/a"]


def test_copy_missing_source_is_enoent(accessor):
    with pytest.raises(FileNotFoundError):
        _managed(
            _copy_for(FakeStore())(accessor, spec("/never"), spec("/dst.txt")))


def test_copy_onto_the_same_key_is_a_guarded_no_op(accessor):
    store = FakeStore({"a.txt": b"hi"})
    manager = _managed(
        _copy_for(store)(accessor, spec("/a.txt"), spec("/a.txt")))
    assert store.objects == {"a.txt": b"hi"}
    assert manager.writes == []


def test_copy_onto_the_same_key_still_fails_when_absent(accessor):
    with pytest.raises(FileNotFoundError):
        _managed(
            _copy_for(FakeStore())(accessor, spec("/a.txt"), spec("/a.txt")))


def test_copy_without_native_copy_refuses_to_build():
    driver = replace(make_driver(FakeStore()), copy_file=None)
    with pytest.raises(ValueError, match="no native copy"):
        make_copy(driver, make_exists(make_stat(driver)))


# ── the retraction record snapshot capture reads ─────────────────────────


def _recorded(coro):
    scope = RecordingScope()
    try:
        _managed(coro)
    finally:
        scope.close()
    return [(r.op, r.path) for r in scope.records]


def test_copy_records_a_retraction_for_the_destination(accessor):
    """A copy replaces dst's bytes and leaves src untouched, so only
    dst's token stops describing its object."""
    store = FakeStore({"a.txt": b"x"})
    assert _recorded(
        make_copy(make_driver(store),
                  _exists)(accessor, spec("/a.txt"),
                           spec("/b.txt"))) == [("copy", "/b.txt")]


def test_self_copy_records_nothing(accessor):
    store = FakeStore({"a.txt": b"x"})
    assert _recorded(
        make_copy(make_driver(store), _exists)(accessor, spec("/a.txt"),
                                               spec("/a.txt"))) == []


async def _exists(accessor, path) -> bool:
    return True


async def _boom(conn, src_key: str, dst_key: str) -> bool:
    raise RuntimeError("boom")


def _recorded_failure(coro, exc_type, match: str | None = None):
    scope = RecordingScope()
    try:
        with pytest.raises(exc_type, match=match):
            _managed(coro)
    finally:
        scope.close()
    return [(r.op, r.path) for r in scope.records]


def test_copy_records_the_retraction_when_the_store_throws(accessor):
    """A raise may have left a partial object on dst, so its token stops
    describing what is there."""
    store = FakeStore({"a.txt": b"x"})
    driver = replace(make_driver(store), copy_file=_boom)
    assert _recorded_failure(
        make_copy(driver, _exists)(accessor, spec("/a.txt"), spec("/b.txt")),
        RuntimeError, "boom") == [("copy", "/b.txt")]


def test_copy_evicts_the_destination_when_the_store_throws(accessor):
    """The eviction rides with the record, on the same condition."""

    async def run():
        driver = replace(make_driver(FakeStore({"a.txt": b"x"})),
                         copy_file=_boom)
        with pytest.raises(RuntimeError):
            await make_copy(driver, _exists)(accessor, spec("/a.txt"),
                                             spec("/b.txt"))

    manager = _managed(run())
    assert manager.writes == ["/b.txt"]


def test_copy_of_a_missing_source_records_nothing(accessor):
    """A clean False is the store saying nothing was copied."""
    assert _recorded_failure(
        make_copy(make_driver(FakeStore()), _exists)(accessor, spec("/a.txt"),
                                                     spec("/b.txt")),
        FileNotFoundError) == []
