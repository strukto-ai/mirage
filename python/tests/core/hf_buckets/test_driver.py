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

import pytest
from opendal.exceptions import NotFound

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.core.hf_buckets.driver import DRIVER, HfConn
from mirage.core.hf_hub.client import HfHubError
from mirage.vfs.hf_buckets.config import HfBucketsConfig
from tests.fixtures.hf_bucket import (
    PATHS_INFO,
    TREE,
    ListedBare,
)


async def _op(make_acc, files: dict[str, bytes]) -> HfConn:
    # The listing primitives read only the operator, over the bucket the
    # files were written to.
    acc = await make_acc(files)
    return HfConn(accessor=acc, op=acc.operator())


def test_driver_contract_pins():
    # No markers (the Hub refuses create_dir), no native move or copy
    # (rename/cp stay unwired → ENOTSUP).
    assert DRIVER.vfs == "hf"
    assert DRIVER.markers_supported is False
    assert DRIVER.move_file is None
    assert DRIVER.move_prefix is None
    assert DRIVER.copy_file is None


def test_key_prefix_rides_the_operator_root():
    # key_prefix is applied as the operator's root, so every key the
    # driver sees is already prefix-relative.
    acc = HfBucketsAccessor(
        HfBucketsConfig(
            bucket="o/b", endpoint="http://127.0.0.1:9", key_prefix="team/data"
        )
    )
    assert DRIVER.key_prefix_of(acc) == ""


@pytest.mark.asyncio
async def test_connect_yields_an_operator_on_the_accessors_bucket(make_acc):
    acc = await make_acc({"a.txt": b"x"})
    async with DRIVER.connect(acc) as conn:
        assert conn.accessor is acc
        assert bytes(await conn.op.read("a.txt")) == b"x"


@pytest.mark.asyncio
async def test_list_children_classifies_dirs_and_files(make_acc):
    op = await _op(
        make_acc, {"data/a.json": b"12345", "data/sub/b.json": b"67"}
    )
    got = [e async for e in DRIVER.list_children(op, "data/")]
    assert sorted((e.key, e.kind, e.size) for e in got) == [
        ("data/a.json", "f", 5),
        ("data/sub", "d", None),
    ]


@pytest.mark.asyncio
async def test_list_children_missing_prefix_yields_nothing(make_acc):
    op = await _op(make_acc, {"other.txt": b"x"})
    assert [e async for e in DRIVER.list_children(op, "gone/")] == []


@pytest.mark.asyncio
async def test_list_children_maps_the_self_entry_to_a_marker(make_acc, bucket):
    op = await _op(make_acc, {"data/a.json": b"1"})
    # The Hub's own page with the listed directory itself first, as the
    # Hub lister can answer one.
    page = await bucket.run.call(
        "GET", "/api/buckets/o/b/tree/data?expand=True&recursive=false"
    )
    await bucket.run.answer_next(
        "GET", TREE, 200, [{"type": "directory", "path": "data"}, *page]
    )
    got = [(e.kind, e.key) async for e in DRIVER.list_children(op, "data/")]
    assert got == [("marker", "data/"), ("f", "data/a.json")]


@pytest.mark.asyncio
async def test_list_children_stat_fills_a_missing_size(make_acc):
    acc = await make_acc({"data/a.json": b"12345"})
    op = HfConn(accessor=acc, op=ListedBare(acc.operator(), "data/a.json"))
    got = [e async for e in DRIVER.list_children(op, "data/")]
    assert [(e.key, e.kind, e.size) for e in got] == [("data/a.json", "f", 5)]


@pytest.mark.asyncio
async def test_list_subtree_of_a_file_stem_yields_only_itself(make_acc):
    op = await _op(make_acc, {"a/b.txt": b"123", "a/b.txt.bak": b"x"})
    got = [(t.key, t.size) async for t in DRIVER.list_subtree(op, "a/b.txt")]
    assert got == [("a/b.txt", 3)]


@pytest.mark.asyncio
async def test_list_subtree_does_not_match_sibling_name_prefixes(make_acc):
    op = await _op(make_acc, {"a/b/c.txt": b"12", "a/bc.txt": b"345"})
    got = [(t.key, t.size) async for t in DRIVER.list_subtree(op, "a/b")]
    assert got == [("a/b/c.txt", 2)]


@pytest.mark.asyncio
async def test_head_returns_meta_for_a_file_and_none_otherwise(
    make_acc, bucket
):
    acc = await make_acc({"a.txt": b"12345", "d/x.txt": b"x"})
    row = await bucket.row("a.txt")
    await bucket.run.record_requests()
    conn = HfConn(accessor=acc, op=acc.operator())
    meta = await DRIVER.head(conn, "a.txt")
    assert meta is not None
    # The token is the paths-info xetHash, the value the download's ETag
    # carries (measured 2026-09-25); opendal's stat reports none at all.
    assert (meta.size, meta.fingerprint) == (5, row["xetHash"])
    assert meta.extra == {"etag": row["xetHash"]}
    # The row carries uploadedAt, and stat still reports no mtime, as it
    # does against the live Hub today.
    assert "uploadedAt" in row
    assert meta.modified is None
    assert await DRIVER.head(conn, "missing.txt") is None
    # paths-info answers [] for a directory, so head reports no object
    # and the kit's probe ladder keeps going.
    assert await DRIVER.head(conn, "d") is None
    assert await bucket.count("stat") == 0


@pytest.mark.asyncio
async def test_head_stamps_nothing_for_a_row_without_a_hash(make_acc, bucket):
    acc = await make_acc({"a.txt": b"12345"})
    await bucket.run.answer_next(
        "POST", PATHS_INFO, 200, [{"type": "file", "path": "a.txt", "size": 5}]
    )
    meta = await DRIVER.head(HfConn(accessor=acc, op=acc.operator()), "a.txt")
    assert meta is not None
    assert (meta.fingerprint, meta.extra) == (None, {})


@pytest.mark.asyncio
async def test_head_refuses_a_row_without_a_size(make_acc, bucket):
    # A zero it made up would be a confident wrong size on a mount that
    # declares every size known.
    acc = await make_acc({"a.txt": b"12345"})
    await bucket.run.answer_next(
        "POST",
        PATHS_INFO,
        200,
        [{"type": "file", "path": "a.txt", "xetHash": "h"}],
    )
    with pytest.raises(HfHubError):
        await DRIVER.head(HfConn(accessor=acc, op=acc.operator()), "a.txt")


@pytest.mark.asyncio
async def test_get_returns_bytes_or_none(make_acc):
    op = await _op(make_acc, {"a.txt": b"hi"})
    assert await DRIVER.get(op, "a.txt") == b"hi"
    assert await DRIVER.get(op, "gone.txt") is None


@pytest.mark.asyncio
async def test_delete_file_is_silent_on_missing(make_acc, bucket):
    op = await _op(make_acc, {"a.txt": b"x"})
    await DRIVER.delete_file(op, "a.txt")
    await DRIVER.delete_file(op, "a.txt")
    assert await bucket.files() == {}


@pytest.mark.asyncio
async def test_delete_prefix_removes_the_subtree_only(make_acc, bucket):
    op = await _op(
        make_acc,
        {
            "data/a.json": b"1",
            "data/sub/b.json": b"2",
            "other.txt": b"3",
        },
    )
    await DRIVER.delete_prefix(op, "data/")
    assert await bucket.files() == {"other.txt": b"3"}


@pytest.mark.asyncio
async def test_probe_prefix_sees_any_key_under_the_prefix(make_acc):
    op = await _op(make_acc, {"data/sub/b.json": b"2"})
    assert await DRIVER.probe_prefix(op, "data/") is True
    assert await DRIVER.probe_prefix(op, "gone/") is False


def test_is_not_found_matches_only_opendal_not_found():
    assert DRIVER.is_not_found(NotFound("path not found", "k")) is True
    assert DRIVER.is_not_found(KeyError("k")) is False


WHEN = datetime(2025, 1, 1, tzinfo=timezone.utc)


async def _dated(bucket) -> None:
    """Answer the next listing under ``data`` with the Hub's own page, its
    rows dated by their last commit.

    Args:
        bucket (HfBucket): the bucket.
    """
    page = await bucket.run.call(
        "GET", "/api/buckets/o/b/tree/data?expand=True&recursive=True"
    )
    dated = [
        {
            **row,
            "lastCommit": {"id": "c", "title": "t", "date": WHEN.isoformat()},
        }
        for row in page
    ]
    await bucket.run.answer_next("GET", TREE, 200, dated)


# A listing's row carries the time its page dates it by. A file stem is
# answered by opendal's stat, which reports no time for a bucket file
# however the HEAD is dated (probed against the binding), so a stem's row
# has none.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path,modified",
    [("data", WHEN), ("data", None), ("data/a.txt", None)],
)
async def test_recursive_rows_preserve_modification_time(
    make_acc, bucket, path, modified
):
    op = await _op(make_acc, {"data/a.txt": b"old"})
    if modified is not None:
        await _dated(bucket)
    rows = [row async for row in DRIVER.list_subtree(op, path)]
    assert len(rows) == 1
    assert rows[0].modified == (modified.isoformat() if modified else "")
