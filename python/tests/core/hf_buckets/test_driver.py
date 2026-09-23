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

from datetime import datetime, timezone
from typing import cast

import pytest
from opendal import AsyncOperator
from opendal.exceptions import NotFound
from opendal.types import EntryMode

from mirage.core.hf_buckets.driver import DRIVER
from tests.core.hf_buckets.conftest import (FakeAsyncOperator, _FakeEntry,
                                            _FakeMetadata, make_accessor)


def _op(fake: FakeAsyncOperator) -> AsyncOperator:
    return cast(AsyncOperator, fake)


async def _with_self_entry(path, inner):
    yield _FakeEntry(path=path, metadata=_FakeMetadata(mode=EntryMode.Dir))
    async for e in inner:
        yield e


class _SelfListingOperator(FakeAsyncOperator):
    """Includes the listed directory itself, as the Hub lister does."""

    async def list(self, path: str, *, recursive: bool = False):
        inner = await super().list(path, recursive=recursive)
        return _with_self_entry(path, inner)


async def _drop_file_meta(inner):
    async for e in inner:
        if e.metadata is not None and e.metadata.mode == EntryMode.File:
            e.metadata = None
        yield e


class _MetalessListOperator(FakeAsyncOperator):
    """Lists files without metadata, as sparse Hub tree pages can."""

    async def list(self, path: str, *, recursive: bool = False):
        inner = await super().list(path, recursive=recursive)
        return _drop_file_meta(inner)


def test_driver_contract_pins():
    # No markers (the Hub refuses create_dir), no native move or copy
    # (rename/cp stay unwired → ENOTSUP), no query push-down.
    assert DRIVER.vfs == "hf"
    assert DRIVER.markers_supported is False
    assert DRIVER.move_file is None
    assert DRIVER.move_prefix is None
    assert DRIVER.copy_file is None
    assert DRIVER.find_tree is None


def test_key_prefix_rides_the_operator_root():
    # key_prefix is applied as the operator's root, so every key the
    # driver sees is already prefix-relative.
    acc = make_accessor({}, key_prefix="team/data")
    assert DRIVER.key_prefix_of(acc) == ""


@pytest.mark.asyncio
async def test_connect_yields_the_accessor_operator():
    acc = make_accessor({"a.txt": b"x"})
    async with DRIVER.connect(acc) as op:
        assert op is acc.operator()


@pytest.mark.asyncio
async def test_list_children_classifies_dirs_and_files():
    op = _op(
        FakeAsyncOperator(files={
            "data/a.json": b"12345",
            "data/sub/b.json": b"67",
        }))
    got = [e async for e in DRIVER.list_children(op, "data/")]
    assert sorted((e.key, e.kind, e.size) for e in got) == [
        ("data/a.json", "f", 5),
        ("data/sub", "d", None),
    ]


@pytest.mark.asyncio
async def test_list_children_missing_prefix_yields_nothing():
    op = _op(FakeAsyncOperator(files={"other.txt": b"x"}))
    assert [e async for e in DRIVER.list_children(op, "gone/")] == []


@pytest.mark.asyncio
async def test_list_children_maps_the_self_entry_to_a_marker():
    op = _op(_SelfListingOperator(files={"data/a.json": b"1"}))
    got = [(e.kind, e.key) async for e in DRIVER.list_children(op, "data/")]
    assert got == [("marker", "data/"), ("f", "data/a.json")]


@pytest.mark.asyncio
async def test_list_children_stat_fills_a_missing_size():
    op = _op(_MetalessListOperator(files={"data/a.json": b"12345"}))
    got = [e async for e in DRIVER.list_children(op, "data/")]
    assert [(e.key, e.kind, e.size) for e in got] == [("data/a.json", "f", 5)]


@pytest.mark.asyncio
async def test_list_tree_yields_every_file_under_the_prefix():
    op = _op(
        FakeAsyncOperator(files={
            "data/a.json": b"12345",
            "data/sub/b.json": b"67",
            "other.txt": b"x",
        }))
    got = [(t.key, t.size) async for t in DRIVER.list_tree(op, "data/")]
    assert sorted(got) == [("data/a.json", 5), ("data/sub/b.json", 2)]


@pytest.mark.asyncio
async def test_list_tree_translates_the_scanned_dir_to_the_prefix():
    op = _op(_SelfListingOperator(files={"data/a.json": b"1"}))
    got = [(t.key, t.size) async for t in DRIVER.list_tree(op, "data/")]
    assert got == [("data/", 0), ("data/a.json", 1)]


@pytest.mark.asyncio
async def test_list_subtree_of_a_file_stem_yields_only_itself():
    op = _op(FakeAsyncOperator(files={"a/b.txt": b"123", "a/b.txt.bak": b"x"}))
    got = [(t.key, t.size) async for t in DRIVER.list_subtree(op, "a/b.txt")]
    assert got == [("a/b.txt", 3)]


@pytest.mark.asyncio
async def test_list_subtree_does_not_match_sibling_name_prefixes():
    op = _op(FakeAsyncOperator(files={"a/b/c.txt": b"12", "a/bc.txt": b"345"}))
    got = [(t.key, t.size) async for t in DRIVER.list_subtree(op, "a/b")]
    assert got == [("a/b/c.txt", 2)]


@pytest.mark.asyncio
async def test_head_returns_meta_for_a_file_and_none_otherwise():
    op = _op(FakeAsyncOperator(files={"a.txt": b"12345", "d/x.txt": b"x"}))
    meta = await DRIVER.head(op, "a.txt")
    assert meta is not None
    assert (meta.size, meta.fingerprint) == (5, "etag-a.txt")
    assert meta.modified == "2026-01-01T00:00:00+00:00"
    assert meta.extra == {"etag": "etag-a.txt"}
    assert await DRIVER.head(op, "missing.txt") is None
    # The Hub stats a directory as EntryMode.Dir; head must classify it
    # as "no such object" so the kit's probe ladder keeps going.
    assert await DRIVER.head(op, "d/") is None


@pytest.mark.asyncio
async def test_get_returns_bytes_or_none():
    op = _op(FakeAsyncOperator(files={"a.txt": b"hi"}))
    assert await DRIVER.get(op, "a.txt") == b"hi"
    assert await DRIVER.get(op, "gone.txt") is None


@pytest.mark.asyncio
async def test_delete_file_is_silent_on_missing():
    fake = FakeAsyncOperator(files={"a.txt": b"x"})
    await DRIVER.delete_file(_op(fake), "a.txt")
    await DRIVER.delete_file(_op(fake), "a.txt")
    assert fake.files == {}


@pytest.mark.asyncio
async def test_delete_prefix_removes_the_subtree_only():
    fake = FakeAsyncOperator(files={
        "data/a.json": b"1",
        "data/sub/b.json": b"2",
        "other.txt": b"3",
    })
    await DRIVER.delete_prefix(_op(fake), "data/")
    assert fake.files == {"other.txt": b"3"}


@pytest.mark.asyncio
async def test_probe_prefix_sees_any_key_under_the_prefix():
    op = _op(FakeAsyncOperator(files={"data/sub/b.json": b"2"}))
    assert await DRIVER.probe_prefix(op, "data/") is True
    assert await DRIVER.probe_prefix(op, "gone/") is False


def test_is_not_found_matches_only_opendal_not_found():
    assert DRIVER.is_not_found(NotFound("path not found", "k")) is True
    assert DRIVER.is_not_found(KeyError("k")) is False


@pytest.mark.asyncio
@pytest.mark.parametrize("method,path", [("list_tree", "data/"),
                                         ("list_subtree", "data"),
                                         ("list_subtree", "data/a.txt")])
@pytest.mark.parametrize("modified",
                         [datetime(2025, 1, 1, tzinfo=timezone.utc), None])
async def test_recursive_rows_preserve_modification_time(
        method, path, modified):
    fake = FakeAsyncOperator(files={"data/a.txt": b"old"})
    fake.metas["data/a.txt"].last_modified = modified
    scan = DRIVER.list_tree if method == "list_tree" else DRIVER.list_subtree
    rows = [row async for row in scan(_op(fake), path)]
    assert len(rows) == 1
    assert rows[0].modified == (modified.isoformat() if modified else "")
