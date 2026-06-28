from types import SimpleNamespace

import pytest
from qdrant_client.http.exceptions import UnexpectedResponse

from mirage.core.qdrant import query
from mirage.resource.qdrant.config import QdrantConfig


def test_coerce_numeric_only():
    assert query._coerce("12") == 12
    assert query._coerce("-3") == -3
    assert query._coerce("cat") == "cat"


def test_coerce_keeps_lossy_numeric_strings():
    assert query._coerce("007") == "007"
    assert query._coerce("05") == "05"
    assert query._coerce("-0") == "-0"


def test_candidate_ids_by_type():
    assert query._candidate_ids("7") == [7]
    uid = "11111111-1111-1111-1111-111111111111"
    assert query._candidate_ids(uid) == [uid]
    assert query._candidate_ids("__nf_missing__") == []


class _StrictClient:

    def __init__(self) -> None:
        self.points = [
            SimpleNamespace(id=1, payload={
                "code": "100",
                "name": "a"
            }),
            SimpleNamespace(id=2, payload={
                "code": "200",
                "name": "b"
            }),
        ]
        self.filtered_calls = 0
        self.index_calls = 0
        self._indexed = False

    async def scroll(self,
                     collection_name,
                     scroll_filter=None,
                     limit=10,
                     offset=None,
                     with_payload=True,
                     with_vectors=False):
        if scroll_filter is not None and not self._indexed:
            self.filtered_calls += 1
            raise UnexpectedResponse(
                400, "Bad Request",
                b'{"status":{"error":"Index required but not found"}}', {})
        pts = self.points
        if scroll_filter is not None:
            conds = {c.key: c.match.value for c in scroll_filter.must}
            pts = [
                p for p in pts if all(
                    str(p.payload.get(k)) == str(v) for k, v in conds.items())
            ]
        start = offset or 0
        window = pts[start:start + limit]
        nxt = start + limit if start + limit < len(pts) else None
        return window, nxt

    async def create_payload_index(self,
                                   collection_name,
                                   field_name,
                                   field_schema=None):
        self.index_calls += 1
        self._indexed = True


class _StrictAccessor:

    def __init__(self, client) -> None:
        self.config = QdrantConfig(collection="c",
                                   group_by=["code"],
                                   id_field="id",
                                   max_rows=1000)
        self._client = client
        self._indexes_ensured: set[str] = set()

    async def client(self):
        return self._client


@pytest.mark.asyncio
async def test_creates_indexes_on_index_required_then_retries():
    client = _StrictClient()
    accessor = _StrictAccessor(client)

    rows = await query.rows_matching(accessor, "c", {"code": "100"}, 100)

    assert [r["id"] for r in rows] == [1]
    assert client.filtered_calls == 1
    assert client.index_calls == 1
    assert "c" in accessor._indexes_ensured


@pytest.mark.asyncio
async def test_does_not_recreate_indexes_on_subsequent_calls():
    client = _StrictClient()
    accessor = _StrictAccessor(client)

    await query.distinct_values(accessor, "c", "code", {"code": "100"}, 100)
    await query.distinct_values(accessor, "c", "code", {"code": "100"}, 100)

    assert client.index_calls == 1


@pytest.mark.asyncio
async def test_non_index_error_propagates():
    client = _StrictClient()

    async def boom(**kwargs):
        raise UnexpectedResponse(500, "err", b"boom", {})

    client.scroll = boom
    accessor = _StrictAccessor(client)

    with pytest.raises(UnexpectedResponse):
        await query.rows_matching(accessor, "c", {"code": "100"}, 100)
