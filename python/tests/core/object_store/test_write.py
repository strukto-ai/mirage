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

from mirage.core.object_store.driver import ObjectMeta
from mirage.core.object_store.write import (
    make_create,
    make_mkdir,
    make_truncate,
    make_write,
)
from mirage.errors.fs import enoent
from mirage.io.cooperative import chunks
from mirage.observe.context import RecordingScope
from mirage.types import FileStat, FileType
from tests.core.object_store.conftest import (
    FakeStore,
    make_driver,
    spec,
)


async def _stream(data):
    yield data


async def _reject_lookup(conn, key):
    raise AssertionError("write metadata must not issue a lookup")


def test_write_puts_the_object(accessor):
    store = FakeStore()
    asyncio.run(
        make_write(make_driver(store))(accessor, spec("/a/b/c.txt"), b"hi")
    )
    assert store.objects == {"a/b/c.txt": b"hi"}


def test_create_puts_an_empty_object(accessor):
    store = FakeStore()
    asyncio.run(make_create(make_driver(store))(accessor, spec("/a/b/c.txt")))
    assert store.objects == {"a/b/c.txt": b""}


def test_truncate_pads_with_nul(accessor):
    store = FakeStore({"a/f.bin": b"0123456789"})
    asyncio.run(
        make_truncate(make_driver(store))(accessor, spec("/a/f.bin"), 4)
    )
    assert store.objects["a/f.bin"] == b"0123"


def test_truncate_extends_a_missing_key(accessor):
    store = FakeStore()
    asyncio.run(make_truncate(make_driver(store))(accessor, spec("/f.bin"), 3))
    assert store.objects["f.bin"] == b"\0\0\0"


@pytest.mark.parametrize(
    "operation", ["write", "create", "truncate", "stream"]
)
def test_mutation_returns_confirmed_metadata_without_a_lookup(
    accessor, operation
):
    store = FakeStore()
    meta = ObjectMeta(
        size=7,
        fingerprint="confirmed-token",
        revision="confirmed-revision",
        extra={"etag": "confirmed-token"},
    )

    async def put(conn, key, data):
        conn.objects[key] = data
        return meta

    async def put_stream(conn, key, data, cond):
        conn.objects[key] = b"".join([piece async for piece in chunks(data)])
        return meta

    driver = replace(
        make_driver(store), put=put, put_stream=put_stream, head=_reject_lookup
    )
    path = spec("/a/result.txt")
    calls = {
        "write": lambda: make_write(driver)(accessor, path, b"hello"),
        "create": lambda: make_create(driver)(accessor, path),
        "truncate": lambda: make_truncate(driver)(accessor, path, 2),
        "stream": lambda: make_write(driver)(
            accessor, path, _stream(b"hello")
        ),
    }
    scope = RecordingScope()
    try:
        row = asyncio.run(calls[operation]())
    finally:
        scope.close()
    assert row == FileStat(
        name="result.txt",
        size=7,
        type=FileType.FILE,
        content="text",
        fingerprint="confirmed-token",
        revision="confirmed-revision",
        extra={"etag": "confirmed-token"},
    )
    assert [r.revision for r in scope.records] == [None]


@pytest.mark.parametrize("operation", ["write", "create", "truncate"])
def test_mutation_without_metadata_returns_none(accessor, operation):
    driver = replace(make_driver(FakeStore()), put=_put_silently)
    path = spec("/a/result.txt")
    calls = {
        "write": lambda: make_write(driver)(accessor, path, b"hello"),
        "create": lambda: make_create(driver)(accessor, path),
        "truncate": lambda: make_truncate(driver)(accessor, path, 2),
    }
    assert asyncio.run(calls[operation]()) is None


def test_mkdir_writes_a_marker(accessor):
    store = FakeStore({"a/": b""})
    asyncio.run(make_mkdir(make_driver(store))(accessor, spec("/a/b")))
    assert store.objects == {"a/": b"", "a/b/": b""}
    asyncio.run(
        make_mkdir(make_driver(store))(accessor, spec("/x/y"), parents=True)
    )


def test_mkdir_refuses_a_name_that_exists(accessor):
    # mkdir(2) answers EEXIST for a directory or a file already there,
    # and `mkdir -p` passes only the directory. Rewriting the marker
    # answered success to every caller that skips the command builder's
    # own check: a guest, FUSE, ws.vfs.
    store = FakeStore({"a/b/": b"", "f.txt": b"x"})
    mkdir = make_mkdir(make_driver(store))
    for path, parents in (
        ("/a/b", False),
        ("/f.txt", False),
        ("/f.txt", True),
    ):
        with pytest.raises(FileExistsError):
            asyncio.run(mkdir(accessor, spec(path), parents=parents))
    assert store.puts == []


def test_mkdir_parents_keeps_an_existing_marker(accessor):
    # A rewrite replaces the marker's metadata and, in a versioned bucket,
    # adds a version; a directory only a key implies still gets a marker.
    store = FakeStore({"a/": b"", "imp/x.txt": b"x"})
    mkdir = make_mkdir(make_driver(store))
    asyncio.run(mkdir(accessor, spec("/a"), parents=True))
    assert store.puts == []
    asyncio.run(mkdir(accessor, spec("/imp"), parents=True))
    assert store.puts == [("imp/", b"")]


def test_mkdir_parents_keys_every_directory_it_makes(accessor):
    # A directory only the leaf's marker implies has no time and goes
    # with the leaf, where GNU keeps every directory `-p` made; one that
    # was there, marked or implied by a key, is left as it is.
    store = FakeStore({"a/": b"", "imp/x.txt": b"x"})
    mkdir = make_mkdir(make_driver(store))
    for path in ("/a/b/c", "/imp/d/e", "/n/m"):
        asyncio.run(mkdir(accessor, spec(path), parents=True))
    assert store.puts == [
        ("a/b/", b""),
        ("a/b/c/", b""),
        ("imp/d/", b""),
        ("imp/d/e/", b""),
        ("n/", b""),
        ("n/m/", b""),
    ]


def test_mkdir_refuses_a_missing_parent_without_parents(accessor):
    # mkdir(2) makes one directory under one that exists; only `-p`
    # makes the chain, so a guest's os.mkdir under a missing parent is
    # ENOENT and puts nothing.
    store = FakeStore()
    with pytest.raises(FileNotFoundError):
        asyncio.run(make_mkdir(make_driver(store))(accessor, spec("/a/b")))
    assert store.puts == []


def test_mkdir_refuses_a_directory_under_a_file(accessor):
    # A marker below a file put a directory under it. mkdir(2) blames
    # the operand; the walk `mkdir -p` makes names the file it stops at.
    store = FakeStore({"f.txt": b"x"})
    mkdir = make_mkdir(make_driver(store))
    for path, parents, named in (
        ("/f.txt/sub", False, "/mnt/f.txt/sub"),
        ("/f.txt/x/y", True, "/mnt/f.txt"),
    ):
        with pytest.raises(NotADirectoryError) as caught:
            asyncio.run(mkdir(accessor, spec(path), parents=parents))
        assert caught.value.filename == named
    assert store.puts == []


def test_mkdir_passes_a_refused_ancestor_with_keys_below(accessor):
    # A grant scoped to rd/* refuses HEAD on the bare key rd; the keys
    # below prove a directory, so nothing above the new one is a file.
    store = FakeStore({"rd/a.txt": b"x"})
    store.refused.add("rd")
    mkdir = make_mkdir(make_driver(store))
    asyncio.run(mkdir(accessor, spec("/rd/new"), parents=True))
    assert store.puts == [("rd/new/", b"")]


def test_mkdir_names_a_refused_ancestor_whose_probe_is_refused(accessor):
    store = FakeStore()
    store.refused.update({"rd", "rd/"})
    mkdir = make_mkdir(make_driver(store))
    with pytest.raises(PermissionError) as caught:
        asyncio.run(mkdir(accessor, spec("/rd/new"), parents=True))
    assert caught.value.errno == errno.EACCES
    assert caught.value.filename == "/mnt/rd"


def test_mkdir_keeps_an_ancestor_lookup_failure_its_own(accessor):
    # A transport fault on an empty ancestor must not turn into EACCES.
    store = FakeStore()
    looked_up = make_driver(store).head

    async def failing_head(conn: FakeStore, key: str) -> ObjectMeta | None:
        if key == "rd":
            raise ConnectionError("reset by peer")
        return await looked_up(conn, key)

    driver = replace(make_driver(store), head=failing_head)
    with pytest.raises(ConnectionError):
        asyncio.run(
            make_mkdir(driver)(accessor, spec("/rd/new"), parents=True)
        )
    assert store.puts == []


@pytest.mark.parametrize(
    "parents, named", [(True, "/mnt/rd"), (False, "/mnt/rd/new")]
)
def test_mkdir_names_a_refused_ancestor_holding_nothing(
    accessor, parents, named
):
    # mkdir(2) blames the operand; the walk `-p` makes names where it stops.
    store = FakeStore()
    store.refused.add("rd")
    mkdir = make_mkdir(make_driver(store))
    with pytest.raises(PermissionError) as caught:
        asyncio.run(mkdir(accessor, spec("/rd/new"), parents=parents))
    assert caught.value.errno == errno.EACCES
    assert caught.value.filename == named
    assert store.puts == []


@pytest.mark.parametrize("parents", [True, False])
def test_mkdir_without_marker_support_is_a_no_op(accessor, parents):
    # Without markers a parent made a moment ago has no row, so even a
    # plain mkdir under it cannot be checked and stays a no-op.
    store = FakeStore()
    driver = replace(make_driver(store), markers_supported=False)
    asyncio.run(make_mkdir(driver)(accessor, spec("/a/b"), parents=parents))
    assert store.objects == {}


async def _put_missing_container(
    conn: FakeStore, key: str, data: bytes
) -> None:
    del conn, data
    raise KeyError(key)


def _enoent_from(fn, path: str) -> FileNotFoundError:
    store = FakeStore()
    driver = replace(make_driver(store), put=_put_missing_container)
    try:
        asyncio.run(fn(driver, spec(path)))
    except FileNotFoundError as exc:
        return exc
    raise AssertionError("expected FileNotFoundError")


def test_write_names_the_path_not_the_key_when_the_container_is_gone(accessor):
    # The driver primitives speak keys, so the store's own error names
    # "a/b/c.txt"; only the factory can restate it as the path the user
    # typed, which is the only spelling allowed in a message.
    exc = _enoent_from(
        lambda d, s: make_write(d)(accessor, s, b"hi"), "/a/b/c.txt"
    )
    assert exc.filename == "/mnt/a/b/c.txt"


def test_create_and_truncate_name_the_path_too(accessor):
    created = _enoent_from(
        lambda d, s: make_create(d)(accessor, s), "/a/new.txt"
    )
    assert created.filename == "/mnt/a/new.txt"
    cut = _enoent_from(
        lambda d, s: make_truncate(d)(accessor, s, 4), "/a/cut.txt"
    )
    assert cut.filename == "/mnt/a/cut.txt"


async def _pinned_revision_gone(
    conn: FakeStore, key: str, revision: str | None
) -> None:
    del conn, revision
    raise enoent(key)


def test_truncate_names_the_path_when_its_pinned_revision_is_gone(accessor):
    driver = replace(
        make_driver(FakeStore()), get_versioned=_pinned_revision_gone
    )
    try:
        asyncio.run(make_truncate(driver)(accessor, spec("/a/cut.txt"), 1))
    except FileNotFoundError as exc:
        assert exc.filename == "/mnt/a/cut.txt"
        return
    raise AssertionError("expected FileNotFoundError")


def test_a_store_error_that_is_not_a_missing_container_propagates(accessor):
    store = FakeStore()

    async def boom(conn: FakeStore, key: str, data: bytes) -> None:
        del conn, key, data
        raise RuntimeError("bucket on fire")

    driver = replace(make_driver(store), put=boom)
    try:
        asyncio.run(make_write(driver)(accessor, spec("/a.txt"), b"hi"))
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
        asyncio.run(coro)
    finally:
        scope.close()
    return scope.records


def test_write_records_the_token_the_put_returned(accessor):
    store = FakeStore()
    records = _recorded(
        make_write(make_driver(store))(accessor, spec("/a/b/c.txt"), b"hi")
    )
    assert [(r.op, r.path, r.fingerprint) for r in records] == [
        ("write", "/mnt/a/b/c.txt", "fp-a/b/c.txt")
    ]


def test_create_records_the_token_the_put_returned(accessor):
    store = FakeStore()
    records = _recorded(
        make_create(make_driver(store))(accessor, spec("/a/new.txt"))
    )
    assert [(r.op, r.path, r.fingerprint) for r in records] == [
        ("create", "/mnt/a/new.txt", "fp-a/new.txt")
    ]


def test_truncate_records_the_token_the_put_returned(accessor):
    store = FakeStore({"a/cut.txt": b"hello"})
    records = _recorded(
        make_truncate(make_driver(store))(accessor, spec("/a/cut.txt"), 2)
    )
    assert [(r.op, r.path, r.fingerprint) for r in records] == [
        ("truncate", "/mnt/a/cut.txt", "fp-a/cut.txt")
    ]


def test_write_records_no_token_when_the_store_reports_none(accessor):
    """A driver whose put answers None (hf, whose opendal write reports
    nothing) records the same absence it does today."""
    driver = replace(make_driver(FakeStore()), put=_put_silently)
    records = _recorded(make_write(driver)(accessor, spec("/a/c.txt"), b"hi"))
    assert [r.fingerprint for r in records] == [None]


def test_mkdir_records_nothing(accessor):
    store = FakeStore()
    records = _recorded(
        make_mkdir(make_driver(store))(accessor, spec("/a/b"), True)
    )
    assert records == []
