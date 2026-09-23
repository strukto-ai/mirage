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

from mirage.cache.context import push_cache_manager
from mirage.core.object_store.write import (make_create, make_mkdir,
                                            make_truncate, make_write_bytes)
from mirage.observe.context import RecordingScope
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


def test_write_puts_and_invalidates_every_ancestor_listing(accessor):
    store = FakeStore()
    manager = _managed(
        make_write_bytes(make_driver(store))(accessor, spec("/a/b/c.txt"),
                                             b"hi"))
    assert store.objects == {"a/b/c.txt": b"hi"}
    assert manager.writes == ["/a/b/c.txt", "/a/b", "/a"]


def test_write_at_mount_root_invalidates_only_itself(accessor):
    store = FakeStore()
    manager = _managed(
        make_write_bytes(make_driver(store))(accessor, spec("/c.txt"), b"x"))
    assert manager.writes == ["/c.txt"]


def test_create_puts_empty_and_invalidates_ancestors(accessor):
    store = FakeStore()
    manager = _managed(
        make_create(make_driver(store))(accessor, spec("/a/b/c.txt")))
    assert store.objects == {"a/b/c.txt": b""}
    assert manager.writes == ["/a/b/c.txt", "/a/b", "/a"]


def test_truncate_pads_with_nul_and_invalidates_ancestors(accessor):
    store = FakeStore({"a/f.bin": b"0123456789"})
    manager = _managed(
        make_truncate(make_driver(store))(accessor, spec("/a/f.bin"), 4))
    assert store.objects["a/f.bin"] == b"0123"
    assert manager.writes == ["/a/f.bin", "/a"]


def test_truncate_extends_a_missing_key(accessor):
    store = FakeStore()
    _managed(make_truncate(make_driver(store))(accessor, spec("/f.bin"), 3))
    assert store.objects["f.bin"] == b"\0\0\0"


def test_mkdir_writes_a_marker_and_parents_gate_ancestors(accessor):
    store = FakeStore()
    manager = _managed(make_mkdir(make_driver(store))(accessor, spec("/a/b")))
    assert store.objects == {"a/b/": b""}
    assert manager.writes == ["/a/b"]
    deep = _managed(
        make_mkdir(make_driver(store))(accessor, spec("/x/y"), parents=True))
    assert deep.writes == ["/x/y", "/x"]


def test_mkdir_without_marker_support_is_a_no_op(accessor):
    store = FakeStore()
    driver = replace(make_driver(store), markers_supported=False)
    manager = _managed(
        make_mkdir(driver)(accessor, spec("/a/b"), parents=True))
    assert store.objects == {}
    assert store.connects == 0
    assert manager.writes == []


async def _put_missing_container(conn: FakeStore, key: str,
                                 data: bytes) -> None:
    del conn, data
    raise KeyError(key)


def _enoent_from(fn, path: str) -> FileNotFoundError:
    store = FakeStore()
    driver = replace(make_driver(store), put=_put_missing_container)
    try:
        _managed(fn(driver, spec(path)))
    except FileNotFoundError as exc:
        return exc
    raise AssertionError("expected FileNotFoundError")


def test_write_names_the_path_not_the_key_when_the_container_is_gone(accessor):
    # The driver primitives speak keys, so the store's own error names
    # "a/b/c.txt"; only the factory can restate it as the path the user
    # typed, which is the only spelling allowed in a message.
    exc = _enoent_from(lambda d, s: make_write_bytes(d)(accessor, s, b"hi"),
                       "/a/b/c.txt")
    assert str(exc) == "/mnt/a/b/c.txt"


def test_create_and_truncate_name_the_path_too(accessor):
    created = _enoent_from(lambda d, s: make_create(d)(accessor, s),
                           "/a/new.txt")
    assert str(created) == "/mnt/a/new.txt"
    cut = _enoent_from(lambda d, s: make_truncate(d)(accessor, s, 4),
                       "/a/cut.txt")
    assert str(cut) == "/mnt/a/cut.txt"


def test_a_store_error_that_is_not_a_missing_container_propagates(accessor):
    store = FakeStore()

    async def boom(conn: FakeStore, key: str, data: bytes) -> None:
        del conn, key, data
        raise RuntimeError("bucket on fire")

    driver = replace(make_driver(store), put=boom)
    try:
        _managed(make_write_bytes(driver)(accessor, spec("/a.txt"), b"hi"))
    except RuntimeError as exc:
        assert str(exc) == "bucket on fire"
    else:
        raise AssertionError("expected RuntimeError")


# ── the backend token the put answered reaches the op record ─────────────


async def _put_silently(conn: FakeStore, key: str, data: bytes) -> None:
    conn.objects[key] = data
    return None


def _recorded(coro):
    scope = RecordingScope()
    try:
        _managed(coro)
    finally:
        scope.close()
    return scope.records


def test_write_records_the_token_the_put_returned(accessor):
    store = FakeStore()
    records = _recorded(
        make_write_bytes(make_driver(store))(accessor, spec("/a/b/c.txt"),
                                             b"hi"))
    assert [(r.op, r.path, r.fingerprint)
            for r in records] == [("write", "/a/b/c.txt", "fp-a/b/c.txt")]


def test_create_records_the_token_the_put_returned(accessor):
    store = FakeStore()
    records = _recorded(
        make_create(make_driver(store))(accessor, spec("/a/new.txt")))
    assert [(r.op, r.path, r.fingerprint)
            for r in records] == [("create", "/a/new.txt", "fp-a/new.txt")]


def test_truncate_records_the_token_the_put_returned(accessor):
    store = FakeStore({"a/cut.txt": b"hello"})
    records = _recorded(
        make_truncate(make_driver(store))(accessor, spec("/a/cut.txt"), 2))
    assert [(r.op, r.path, r.fingerprint)
            for r in records] == [("truncate", "/a/cut.txt", "fp-a/cut.txt")]


def test_write_records_no_token_when_the_store_reports_none(accessor):
    """A driver whose put answers None (hf, whose opendal write reports
    nothing) records the same absence it does today."""
    driver = replace(make_driver(FakeStore()), put=_put_silently)
    records = _recorded(
        make_write_bytes(driver)(accessor, spec("/a/c.txt"), b"hi"))
    assert [r.fingerprint for r in records] == [None]


def test_mkdir_records_nothing(accessor):
    store = FakeStore()
    records = _recorded(
        make_mkdir(make_driver(store))(accessor, spec("/a/b"), True))
    assert records == []
