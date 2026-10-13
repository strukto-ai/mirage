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

import datetime as dt
import json
from contextlib import contextmanager
from unittest.mock import AsyncMock, patch

import pytest
from bson import Decimal128, ObjectId, Timestamp

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.mongodb.stream import (
    follow,
    last_lines,
    line_count,
    read_stream,
)
from mirage.errors.types import FileTooLargeError
from mirage.io.stream import close_quietly
from mirage.types import PathSpec
from mirage.vfs.mongodb.config import MongoDBConfig

DOCS_PATH = "/db1/collections/coll1/documents.jsonl"
VIEW_DOCS_PATH = "/db1/views/myview/documents.jsonl"


async def _gen(items):
    for item in items:
        yield item


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.fixture(autouse=True)
def visible_collections(monkeypatch):
    # Every documents stream proves its collection through the entity
    # guard first; these tests are about rendering, so the catalog says
    # yes. The scope tests at the bottom replace it.
    monkeypatch.setattr(
        "mirage.core.mongodb.readdir.entity_exists",
        AsyncMock(return_value=True),
    )


@pytest.fixture
def accessor():
    return MongoDBAccessor(
        config=MongoDBConfig(uri="mongodb://localhost:27017")
    )


def _patched_iter(docs):
    return patch(
        "mirage.core.mongodb.stream.iter_documents",
        new=lambda *args, **kwargs: _gen(docs),
    )


@contextmanager
def _patched_watch(docs, last=(), after=Timestamp(1, 1)):
    with (
        patch(
            "mirage.core.mongodb.stream.iter_inserts",
            new=lambda *args, **kwargs: _gen(docs),
        ),
        patch(
            "mirage.core.mongodb.stream.find_snapshot",
            new=AsyncMock(return_value=(list(last), after)),
        ),
    ):
        yield


def _path(s: str) -> PathSpec:
    return PathSpec(virtual=s, directory=s, vfs_path=s.strip("/"))


async def _followed(acc, path, index=None, n=0):
    stream = await follow(acc, _path(path), n, index)
    assert stream is not None
    return stream


async def _collect(gen):
    chunks = []
    async for chunk in gen:
        chunks.append(chunk)
    return b"".join(chunks)


@pytest.mark.asyncio
async def test_read_stream_yields_one_jsonl_line_per_doc(accessor, index):
    oid_a, oid_b = ObjectId(), ObjectId()
    docs = [{"_id": oid_a, "title": "A"}, {"_id": oid_b, "title": "B"}]
    with _patched_iter(docs):
        data = await _collect(read_stream(accessor, _path(DOCS_PATH), index))
    lines = [line for line in data.decode().split("\n") if line]
    assert len(lines) == 2
    first = json.loads(lines[0])
    assert first["title"] == "A"
    assert first["_id"] == {"$oid": str(oid_a)}


@pytest.mark.asyncio
async def test_read_stream_preserves_bson_types_via_extended_json(
    accessor, index
):
    docs = [
        {
            "_id": ObjectId("65f0000000000000000000a1"),
            "date": dt.datetime(
                2026, 5, 15, 12, 30, 45, tzinfo=dt.timezone.utc
            ),
            "decimal": Decimal128("123.456"),
        }
    ]
    with _patched_iter(docs):
        data = await _collect(read_stream(accessor, _path(DOCS_PATH), index))
    parsed = json.loads(data.decode().strip())
    assert parsed["_id"] == {"$oid": "65f0000000000000000000a1"}
    assert "$date" in parsed["date"]
    assert parsed["decimal"] == {"$numberDecimal": "123.456"}


@pytest.mark.asyncio
async def test_read_stream_empty_yields_nothing(accessor, index):
    with _patched_iter([]):
        chunks = []
        async for chunk in read_stream(accessor, _path(DOCS_PATH), index):
            chunks.append(chunk)
    assert chunks == []


@pytest.mark.asyncio
async def test_read_stream_short_circuits_when_consumer_closes(
    accessor, index
):
    consumed: list[int] = []

    async def _instrumented(*_args, **_kwargs):
        for i in range(1000):
            consumed.append(i)
            yield {"_id": ObjectId(), "i": i}

    with patch("mirage.core.mongodb.stream.iter_documents", new=_instrumented):
        gen = read_stream(accessor, _path(DOCS_PATH), index)
        await gen.__anext__()
        await gen.aclose()
    assert len(consumed) <= 2


@pytest.mark.asyncio
async def test_read_stream_works_on_view_documents_path(accessor, index):
    oid = ObjectId()
    docs = [{"_id": oid, "v": 1}]
    with _patched_iter(docs):
        data = await _collect(
            read_stream(accessor, _path(VIEW_DOCS_PATH), index)
        )
    parsed = json.loads(data.decode().strip())
    assert parsed["v"] == 1
    assert parsed["_id"] == {"$oid": str(oid)}


@pytest.mark.asyncio
async def test_read_stream_directory_path_raises(accessor, index):
    with _patched_iter([]):
        with pytest.raises(FileNotFoundError):
            async for _ in read_stream(accessor, _path("/db1"), index):
                pass


@pytest.mark.asyncio
async def test_read_stream_schema_json_path_raises(accessor, index):
    with _patched_iter([]):
        with pytest.raises(FileNotFoundError):
            async for _ in read_stream(
                accessor, _path("/db1/collections/coll1/schema.json"), index
            ):
                pass


@pytest.mark.asyncio
async def test_read_stream_elides_configured_top_level_field(index):
    cfg = MongoDBConfig(
        uri="mongodb://localhost:27017",
        elide_fields={"db1.coll1": ["vector"]},
    )
    acc = MongoDBAccessor(config=cfg)
    oid = ObjectId()
    docs = [{"_id": oid, "title": "hi", "vector": [0.1, 0.2, 0.3, 0.4, 0.5]}]
    with _patched_iter(docs):
        data = await _collect(read_stream(acc, _path(DOCS_PATH), index))
    parsed = json.loads(data.decode().strip())
    assert parsed["title"] == "hi"
    assert "vector" not in parsed
    assert parsed["_id"] == {"$oid": str(oid)}


@pytest.mark.asyncio
async def test_read_stream_elides_configured_nested_path(index):
    cfg = MongoDBConfig(
        uri="mongodb://localhost:27017",
        elide_fields={"db1.coll1": ["metadata.embedding"]},
    )
    acc = MongoDBAccessor(config=cfg)
    docs = [
        {
            "_id": ObjectId(),
            "metadata": {
                "tag": "alpha",
                "embedding": [0.1] * 1024,
            },
        }
    ]
    with _patched_iter(docs):
        data = await _collect(read_stream(acc, _path(DOCS_PATH), index))
    parsed = json.loads(data.decode().strip())
    assert parsed["metadata"]["tag"] == "alpha"
    assert "embedding" not in parsed["metadata"]


@pytest.mark.asyncio
async def test_read_stream_elision_isolated_to_configured_collection(index):
    cfg = MongoDBConfig(
        uri="mongodb://localhost:27017",
        elide_fields={"db1.other_coll": ["vector"]},
    )
    acc = MongoDBAccessor(config=cfg)
    docs = [{"_id": ObjectId(), "vector": [1.0, 2.0]}]
    with _patched_iter(docs):
        data = await _collect(read_stream(acc, _path(DOCS_PATH), index))
    parsed = json.loads(data.decode().strip())
    assert parsed["vector"] == [1.0, 2.0]


@pytest.mark.asyncio
async def test_follow_yields_one_jsonl_line_per_insert(accessor, index):
    oid_a, oid_b = ObjectId(), ObjectId()
    docs = [{"_id": oid_a, "title": "A"}, {"_id": oid_b, "title": "B"}]
    with _patched_watch(docs):
        data = await _collect(await _followed(accessor, DOCS_PATH, index))
    lines = [line for line in data.decode().split("\n") if line]
    assert len(lines) == 2
    assert json.loads(lines[0])["_id"] == {"$oid": str(oid_a)}
    assert json.loads(lines[1])["title"] == "B"


@pytest.mark.asyncio
async def test_follow_preserves_bson_types(accessor, index):
    docs = [
        {
            "_id": ObjectId("65f0000000000000000000a1"),
            "date": dt.datetime(
                2026, 5, 15, 12, 30, 45, tzinfo=dt.timezone.utc
            ),
            "decimal": Decimal128("123.456"),
        }
    ]
    with _patched_watch(docs):
        data = await _collect(await _followed(accessor, DOCS_PATH, index))
    parsed = json.loads(data.decode().strip())
    assert parsed["_id"] == {"$oid": "65f0000000000000000000a1"}
    assert "$date" in parsed["date"]
    assert parsed["decimal"] == {"$numberDecimal": "123.456"}


@pytest.mark.asyncio
async def test_follow_empty_yields_nothing(accessor, index):
    with _patched_watch([]):
        chunks = []
        async for chunk in await _followed(accessor, DOCS_PATH, index):
            chunks.append(chunk)
    assert chunks == []


@pytest.mark.asyncio
async def test_follow_short_circuits_when_consumer_closes(accessor, index):
    consumed: list[int] = []

    async def _instrumented(*_args, **_kwargs):
        for i in range(1000):
            consumed.append(i)
            yield {"_id": ObjectId(), "i": i}

    with (
        patch("mirage.core.mongodb.stream.iter_inserts", new=_instrumented),
        patch(
            "mirage.core.mongodb.stream.find_snapshot",
            new=AsyncMock(return_value=([], Timestamp(1, 1))),
        ),
    ):
        gen = await _followed(accessor, DOCS_PATH, index)
        await gen.__anext__()
        await close_quietly(gen)
    assert len(consumed) <= 2


@pytest.mark.asyncio
async def test_follow_reads_the_last_documents_at_the_time_it_follows_from(
    accessor, index
):
    at = Timestamp(42, 1)
    snapshot = AsyncMock(
        return_value=(
            [
                {"_id": 8, "name": "hal"},
                {"_id": 7, "name": "gus"},
                {"_id": 6, "name": "fay"},
            ],
            at,
        )
    )
    seen: list[Timestamp] = []

    async def _inserts(_client, _database, _name, after):
        seen.append(after)
        yield {"_id": 9, "name": "ida"}

    with (
        patch("mirage.core.mongodb.stream.iter_inserts", new=_inserts),
        patch("mirage.core.mongodb.stream.find_snapshot", new=snapshot),
    ):
        gen = await _followed(accessor, DOCS_PATH, index, n=2)
        assert seen == []
        data = await _collect(gen)
    assert data.decode().splitlines() == [
        '{"_id": 7, "name": "gus"}',
        '{"_id": 8, "name": "hal"}',
        '{"_id": 9, "name": "ida"}',
    ]
    assert seen == [at]
    snapshot.assert_awaited_once_with(
        accessor.client, "db1", "coll1", sort=[("_id", -1)], limit=2
    )


@pytest.mark.asyncio
async def test_follow_without_last_lines_still_starts_at_a_snapshot(
    accessor, index
):
    snapshot = AsyncMock(return_value=([{"_id": 8}], Timestamp(5, 1)))
    with (
        _patched_watch([{"_id": 9}]),
        patch("mirage.core.mongodb.stream.find_snapshot", new=snapshot),
    ):
        data = await _collect(await _followed(accessor, DOCS_PATH, index))
    assert data == b'{"_id": 9}\n'
    assert snapshot.await_args.kwargs["limit"] == 1


@pytest.mark.asyncio
async def test_follow_prints_an_insert_that_renders_like_a_printed_one(index):
    acc = MongoDBAccessor(
        config=MongoDBConfig(
            uri="mongodb://localhost:27017",
            elide_fields={"db1.coll1": ["_id"]},
        )
    )
    with _patched_watch(
        [{"_id": 2, "name": "gus"}], last=[{"_id": 1, "name": "gus"}]
    ):
        data = await _collect(await _followed(acc, DOCS_PATH, index, n=1))
    assert data == b'{"name": "gus"}\n{"name": "gus"}\n'


@pytest.mark.asyncio
async def test_follow_leaves_a_view_or_a_directory_to_the_polls(
    accessor, index
):
    with _patched_watch([]):
        for path in ("/db1", VIEW_DOCS_PATH):
            assert await follow(accessor, _path(path), 5, index) is None


@pytest.mark.asyncio
async def test_last_lines_returns_docs_in_ascending_order(accessor):
    docs = [{"_id": 5, "name": "e"}, {"_id": 4, "name": "d"}]
    with patch(
        "mirage.core.mongodb.stream.find_documents",
        new_callable=AsyncMock,
        return_value=list(docs),
    ) as fake:
        data = await last_lines(accessor, _path(DOCS_PATH), 2)
    assert data is not None
    lines = data.decode().splitlines()
    assert '"_id": 4' in lines[0]
    assert '"_id": 5' in lines[1]
    assert data.endswith(b"\n")
    assert fake.await_args.kwargs["limit"] == 2
    assert fake.await_args.kwargs["sort"] == [("_id", -1)]


@pytest.mark.asyncio
async def test_last_lines_caps_limit_at_max_doc_limit(accessor):
    # A count past the ceiling fetches the ceiling; whether that stopped
    # the read short depends on how many documents there are.
    with (
        patch(
            "mirage.core.mongodb.stream.find_documents",
            new_callable=AsyncMock,
            return_value=[],
        ) as fake,
        patch(
            "mirage.core.mongodb.stream.count_documents",
            new=AsyncMock(return_value=3),
        ),
    ):
        data = await last_lines(accessor, _path(DOCS_PATH), 10**9)
    assert data == b""
    assert fake.await_args.kwargs["limit"] == accessor.config.max_doc_limit


@pytest.mark.asyncio
async def test_last_lines_past_the_ceiling_is_efbig():
    """``min(n, max_doc_limit)`` stood in for the count with nothing to
    say so: ``tail -n 6000`` of a larger collection printed 5000 lines
    and exited 0."""
    acc = MongoDBAccessor(
        config=MongoDBConfig(uri="mongodb://localhost:27017", max_doc_limit=2)
    )
    docs = [{"_id": 9, "n": 9}, {"_id": 8, "n": 8}]
    with (
        patch(
            "mirage.core.mongodb.stream.find_documents",
            new=AsyncMock(return_value=list(docs)),
        ),
        patch(
            "mirage.core.mongodb.stream.count_documents",
            new=AsyncMock(return_value=10),
        ),
    ):
        with pytest.raises(FileTooLargeError, match="documents.jsonl"):
            await last_lines(acc, _path(DOCS_PATH), 5)


@pytest.mark.asyncio
async def test_last_lines_applies_elision(index):
    cfg = MongoDBConfig(
        uri="mongodb://localhost:27017",
        elide_fields={"db1.coll1": ["vector"]},
    )
    acc = MongoDBAccessor(config=cfg)
    docs = [{"_id": 1, "title": "hi", "vector": [0.1, 0.2]}]
    with patch(
        "mirage.core.mongodb.stream.find_documents",
        new_callable=AsyncMock,
        return_value=docs,
    ):
        data = await last_lines(acc, _path(DOCS_PATH), 1)
    assert data is not None
    parsed = json.loads(data.decode().strip())
    assert parsed["title"] == "hi"
    assert "vector" not in parsed


@pytest.mark.asyncio
async def test_a_file_that_is_not_documents_is_left_to_the_read(accessor):
    path = _path("/db1/collections/coll1/schema.json")
    assert await last_lines(accessor, path, 5) is None
    assert await line_count(accessor, path) is None


@pytest.mark.asyncio
async def test_line_count_counts_the_documents(accessor):
    with patch(
        "mirage.core.mongodb.stream.count_documents",
        new=AsyncMock(return_value=7),
    ):
        assert await line_count(accessor, _path(VIEW_DOCS_PATH)) == 7


@pytest.mark.asyncio
async def test_follow_applies_elision(index):
    cfg = MongoDBConfig(
        uri="mongodb://localhost:27017",
        elide_fields={"db1.coll1": ["vector"]},
    )
    acc = MongoDBAccessor(config=cfg)
    oid = ObjectId()
    docs = [{"_id": oid, "title": "live", "vector": [0.1, 0.2, 0.3]}]
    with _patched_watch(docs):
        data = await _collect(await _followed(acc, DOCS_PATH, index))
    parsed = json.loads(data.decode().strip())
    assert parsed["title"] == "live"
    assert "vector" not in parsed
    assert parsed["_id"] == {"$oid": str(oid)}


@pytest.mark.asyncio
@pytest.mark.parametrize("opener", ["read", "follow", "last", "count"])
async def test_a_collection_outside_the_scope_is_enoent_to_every_stream(
    monkeypatch, opener
):
    """The documents streams went straight to the collection the path
    names, so a database ``databases`` leaves out streamed while ``ls``
    and ``stat`` said it was not there."""
    accessor = MongoDBAccessor(
        config=MongoDBConfig(
            uri="mongodb://localhost:27017", databases=["db1"]
        )
    )
    exists = AsyncMock(return_value=False)
    monkeypatch.setattr("mirage.core.mongodb.readdir.entity_exists", exists)
    fetched = AsyncMock(side_effect=AssertionError("queried the collection"))
    path = _path("/secret/collections/coll1/documents.jsonl")
    with (
        patch("mirage.core.mongodb.stream.iter_documents", new=fetched),
        patch("mirage.core.mongodb.stream.iter_inserts", new=fetched),
        patch("mirage.core.mongodb.stream.find_snapshot", new=fetched),
        patch("mirage.core.mongodb.stream.find_documents", new=fetched),
        patch("mirage.core.mongodb.stream.count_documents", new=fetched),
    ):
        with pytest.raises(FileNotFoundError):
            if opener == "last":
                await last_lines(accessor, path, 5)
            elif opener == "count":
                await line_count(accessor, path)
            elif opener == "follow":
                await follow(accessor, path, 5)
            else:
                await _collect(read_stream(accessor, path))
    exists.assert_awaited_once()
