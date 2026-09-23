from types import SimpleNamespace

import pytest
from qdrant_client import models
from qdrant_client.http.exceptions import UnexpectedResponse

from mirage.core.qdrant import query
from mirage.vfs.qdrant.config import QdrantConfig


def _match_value(condition):
    return condition.match.value


def test_condition_is_the_string_alone_for_a_plain_segment():
    cond = query._condition("k", "cat")
    assert isinstance(cond, models.FieldCondition)
    assert _match_value(cond) == "cat"


def test_condition_adds_the_typed_scalar_a_segment_also_spells():
    # The listing renders a boolean or a number as compact JSON, so the
    # segment matches the string and the typed payload both; a number is
    # a closed range so integer and float payloads alike answer.
    as_bool = query._condition("k", "true")
    assert isinstance(as_bool, models.Filter)
    assert [_match_value(c) for c in as_bool.should] == ["true", True]
    as_int = query._condition("k", "12")
    text, typed = as_int.should
    assert _match_value(text) == "12"
    assert (typed.range.gte, typed.range.lte) == (12, 12)
    as_float = query._condition("k", "1.5")
    assert (as_float.should[1].range.gte,
            as_float.should[1].range.lte) == (1.5, 1.5)


def test_condition_keeps_a_spelling_no_value_renders_as_a_string():
    for text in ("007", "05", "-0", "1.50", "1e5", "NaN", "null"):
        assert isinstance(query._condition("k", text), models.FieldCondition)


def test_filter_is_none_when_nothing_narrows():
    assert query._filter({}) is None
    assert len(query._filter({"a": "x", "b": "2"}).must) == 2


def test_candidate_ids_by_type():
    assert query._candidate_ids("7") == [7]
    uid = "11111111-1111-1111-1111-111111111111"
    assert query._candidate_ids(uid) == [uid]
    assert query._candidate_ids("__nf_missing__") == []


class _StrictClient:

    def __init__(self, holds) -> None:
        self._holds = holds
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
            pts = [p for p in pts if self._holds(p, scroll_filter)]
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
async def test_creates_indexes_on_index_required_then_retries(holds):
    client = _StrictClient(holds)
    accessor = _StrictAccessor(client)

    rows = await query.rows_matching(accessor, "c", {"code": "100"}, 100)

    assert [r["id"] for r in rows] == [1]
    assert client.filtered_calls == 1
    assert client.index_calls == 1
    assert "c" in accessor._indexes_ensured


@pytest.mark.asyncio
async def test_does_not_recreate_indexes_on_subsequent_calls(holds):
    client = _StrictClient(holds)
    accessor = _StrictAccessor(client)

    await query.distinct_values(accessor, "c", "code", {"code": "100"}, 100)
    await query.distinct_values(accessor, "c", "code", {"code": "100"}, 100)

    assert client.index_calls == 1


@pytest.mark.asyncio
async def test_resolve_group_finds_every_source_behind_one_basename(accessor):
    client = await accessor.client()
    for point in client.points[:3]:
        point.payload["source"] = "s3://one/report.pdf"
    client.points[3].payload["source"] = "s3://two/report.pdf"

    both = await query.resolve_group(accessor, "animals", "source", {},
                                     "report.pdf", True)
    assert both == ["s3://one/report.pdf", "s3://two/report.pdf"]
    assert await query.resolve_group(accessor, "animals", "source", {},
                                     "other.pdf", True) == []


@pytest.mark.asyncio
async def test_non_index_error_propagates(holds):
    client = _StrictClient(holds)

    async def boom(**kwargs):
        raise UnexpectedResponse(500, "err", b"boom", {})

    client.scroll = boom
    accessor = _StrictAccessor(client)

    with pytest.raises(UnexpectedResponse):
        await query.rows_matching(accessor, "c", {"code": "100"}, 100)


@pytest.mark.asyncio
async def test_group_values_spell_a_non_string_as_its_json_does(accessor):
    # Python's ``str(True)`` and TypeScript's ``String(true)`` disagree,
    # so a boolean payload spells as JSON on both sides of the listing:
    # the distinct values and the value a rendered segment resolves to.
    client = await accessor.client()
    client.points[0].payload["label"] = True
    client.points[1].payload["label"] = 1.0
    values = await query.distinct_values(accessor, "animals", "label", {}, 100)
    assert values == ["1", "dog", "true"]
    assert await query.resolve_group(accessor, "animals", "label", {},
                                     "true") == ["true"]
    # Descending into the advertised directory filters for the typed
    # payload, not for the string the segment spells.
    behind_true = await query.distinct_values(accessor, "animals", "kind",
                                              {"label": "true"}, 100)
    assert behind_true == [client.points[0].payload["kind"]]
    behind_one = await query.distinct_values(accessor, "animals", "kind",
                                             {"label": "1"}, 100)
    assert behind_one == [client.points[1].payload["kind"]]
