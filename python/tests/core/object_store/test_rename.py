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

from mirage.core.object_store.exists import make_exists
from mirage.core.object_store.rename import make_rename
from mirage.core.object_store.stat import make_stat
from mirage.observe.context import RecordingScope
from tests.core.object_store.conftest import (
    FakeStore,
    make_driver,
    spec,
)


def _rename_for(store: FakeStore):
    driver = make_driver(store)
    return make_rename(driver, make_exists(make_stat(driver)))


def test_rename_moves_a_file(accessor):
    store = FakeStore({"a/src.txt": b"hi"})
    asyncio.run(
        _rename_for(store)(accessor, spec("/a/src.txt"), spec("/b/dst.txt"))
    )
    assert store.objects == {"b/dst.txt": b"hi"}
    # A file has nothing beneath it, so neither end walks the caches for
    # a subtree: both take the unlink flavor.


def test_rename_falls_back_to_the_prefix_walk(accessor):
    store = FakeStore({"dir/f.txt": b"x", "dir/sub/g.txt": b"y"})
    asyncio.run(_rename_for(store)(accessor, spec("/dir"), spec("/moved")))
    assert store.objects == {"moved/f.txt": b"x", "moved/sub/g.txt": b"y"}


def test_rename_missing_source_is_enoent(accessor):
    store = FakeStore()
    with pytest.raises(FileNotFoundError):
        asyncio.run(_rename_for(store)(accessor, spec("/never"), spec("/dst")))


def test_rename_onto_the_same_key_is_a_guarded_no_op(accessor):
    store = FakeStore({"a.txt": b"hi"})
    asyncio.run(_rename_for(store)(accessor, spec("/a.txt"), spec("/a.txt")))
    assert store.objects == {"a.txt": b"hi"}


def test_rename_onto_the_same_key_still_fails_when_absent(accessor):
    with pytest.raises(FileNotFoundError):
        asyncio.run(
            _rename_for(FakeStore())(accessor, spec("/a.txt"), spec("/a.txt"))
        )


def test_rename_without_native_move_refuses_to_build():
    driver = replace(
        make_driver(FakeStore()), move_file=None, move_prefix=None
    )
    with pytest.raises(ValueError, match="no native move"):
        make_rename(driver, make_exists(make_stat(driver)))


# ── the retraction records snapshot capture reads ────────────────────────


def _recorded(coro):
    scope = RecordingScope()
    try:
        asyncio.run(coro)
    finally:
        scope.close()
    return [(r.op, r.path) for r in scope.records]


def test_rename_records_a_retraction_for_both_paths(accessor):
    """A move invalidates the token of both: src's object left, dst's was
    replaced by it. A single object moved, so the op is the point one and
    nothing under the name is retracted."""
    store = FakeStore({"a.txt": b"x"})
    assert _recorded(
        make_rename(make_driver(store), _exists)(
            accessor, spec("/a.txt"), spec("/b.txt")
        )
    ) == [("rename", "/mnt/a.txt"), ("rename", "/mnt/b.txt")]


def test_self_rename_records_nothing(accessor):
    """POSIX rename(2) of a path onto itself performs no other action."""
    store = FakeStore({"a.txt": b"x"})
    assert (
        _recorded(
            make_rename(make_driver(store), _exists)(
                accessor, spec("/a.txt"), spec("/a.txt")
            )
        )
        == []
    )


async def _exists(accessor, path) -> bool:
    return True


async def _boom(conn, src_pfx: str, dst_pfx: str) -> bool:
    raise RuntimeError("boom")


def _recorded_failure(coro, exc_type, match: str | None = None):
    scope = RecordingScope()
    try:
        with pytest.raises(exc_type, match=match):
            asyncio.run(coro)
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
        RuntimeError,
        "boom",
    ) == [("rename_prefix", "/mnt/d"), ("rename_prefix", "/mnt/e")]


def test_rename_of_a_missing_source_records_nothing(accessor):
    """Both calls answering a clean False is the store saying nothing
    moved at all, which is the one outcome safe to skip."""
    assert (
        _recorded_failure(
            make_rename(make_driver(FakeStore()), _exists)(
                accessor, spec("/a.txt"), spec("/b.txt")
            ),
            FileNotFoundError,
        )
        == []
    )
