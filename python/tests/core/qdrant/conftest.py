import base64
from difflib import SequenceMatcher
from types import SimpleNamespace

import pytest
from qdrant_client import models

from mirage.core.qdrant.payload import field_value
from mirage.vfs.qdrant.config import QdrantConfig

COLLECTION = "animals"

_ROWS = [
    {
        "id": 1,
        "label": "cat",
        "kind": "big",
        "name": "a big orange cat"
    },
    {
        "id": 2,
        "label": "cat",
        "kind": "small",
        "name": "a small grey cat"
    },
    {
        "id": 3,
        "label": "dog",
        "kind": "big",
        "name": "a big brown dog"
    },
    {
        "id": 4,
        "label": "dog",
        "kind": "small",
        "name": "a small white dog"
    },
]


def _points() -> list[SimpleNamespace]:
    points = []
    for row in _ROWS:
        payload = {
            "label": row["label"],
            "kind": row["kind"],
            "name": row["name"],
            "image_bytes":
            base64.b64encode(f"PNG-{row['id']}".encode()).decode(),
        }
        points.append(SimpleNamespace(id=row["id"], payload=payload))
    return points


def filter_holds(point: SimpleNamespace, condition) -> bool:
    """Whether a point satisfies a Qdrant filter the way the server would.

    Typed: a ``match`` compares value and type, so the string ``"1"``
    does not satisfy an integer match, and a ``range`` reads numbers only.
    """
    if condition is None:
        return True
    if isinstance(condition, models.Filter):
        if condition.must and not all(
                filter_holds(point, c) for c in condition.must):
            return False
        if condition.should and not any(
                filter_holds(point, c) for c in condition.should):
            return False
        return True
    value = field_value(point.payload or {}, condition.key)
    if condition.range is not None:
        return (isinstance(value,
                           (int, float)) and not isinstance(value, bool)
                and condition.range.gte <= value <= condition.range.lte)
    want = condition.match.value
    return type(value) is type(want) and value == want


class FakeQdrantClient:

    def __init__(self) -> None:
        self.points = _points()

    async def get_collections(self):
        return SimpleNamespace(collections=[SimpleNamespace(name=COLLECTION)])

    async def collection_exists(self, name: str) -> bool:
        return name == COLLECTION

    async def scroll(self,
                     collection_name,
                     scroll_filter=None,
                     limit=10,
                     offset=None,
                     with_payload=True,
                     with_vectors=False):
        matched = [p for p in self.points if filter_holds(p, scroll_filter)]
        start = offset or 0
        window = matched[start:start + limit]
        nxt = start + limit if start + limit < len(matched) else None
        return window, nxt

    async def retrieve(self,
                       collection_name,
                       ids,
                       with_payload=True,
                       with_vectors=False):
        return [p for p in self.points if p.id in ids]

    async def create_payload_index(self,
                                   collection_name,
                                   field_name,
                                   field_schema=None):
        pass

    async def query_points(self,
                           collection_name,
                           query=None,
                           limit=10,
                           with_payload=True):
        text = query.text if query is not None else ""
        ranked = sorted(
            self.points,
            key=lambda p: SequenceMatcher(
                None, text, str((p.payload or {}).get("name", ""))).ratio(),
            reverse=True,
        )
        scored = []
        for point in ranked[:limit]:
            ratio = SequenceMatcher(None, text,
                                    str((point.payload
                                         or {}).get("name", ""))).ratio()
            scored.append(
                SimpleNamespace(id=point.id,
                                payload=point.payload,
                                score=ratio))
        return SimpleNamespace(points=scored)


class FakeAccessor:

    def __init__(self, config: QdrantConfig, client: FakeQdrantClient) -> None:
        self.config = config
        self._client = client
        self._search_cache: dict = {}
        self._indexes_ensured: set[str] = set()

    async def client(self):
        return self._client

    def cached_search(self, key):
        return self._search_cache.get(key)

    def store_search(self, key, rows):
        self._search_cache[key] = rows


@pytest.fixture
def qdrant_config() -> QdrantConfig:
    return QdrantConfig(
        group_by=["label", "kind"],
        id_field="id",
        text_field="name",
        blob_field="image_bytes",
        blob_ext="png",
        vector_field="vector",
    )


@pytest.fixture
def accessor(qdrant_config) -> FakeAccessor:
    return FakeAccessor(qdrant_config, FakeQdrantClient())


@pytest.fixture
def lineage() -> FakeAccessor:
    client = FakeQdrantClient()
    client.points[0].payload = {
        "page_content": "Refunds are processed within 14 days",
        "metadata": {
            "source": "s3://docs/policies/refund-2026.pdf",
            "page": "004",
        },
    }
    client.points = client.points[:1]
    config = QdrantConfig(
        collection=COLLECTION,
        group_by=["metadata.source"],
        basename_fields=["metadata.source"],
        name_field="metadata.page",
        text_field="page_content",
    )
    return FakeAccessor(config, client)


@pytest.fixture
def slashed() -> FakeAccessor:
    """Two labels a lossy ``∕`` decode would merge into one directory."""
    client = FakeQdrantClient()
    client.points[0].payload["label"] = "a/b"
    client.points[1].payload["label"] = "a∕b"
    client.points = client.points[:2]
    return FakeAccessor(
        QdrantConfig(collection=COLLECTION,
                     group_by=["label"],
                     text_field="name"), client)


@pytest.fixture
def edged() -> FakeAccessor:
    """A blank label and a dot-led one, the two a raw rendering loses."""
    client = FakeQdrantClient()
    client.points[0].payload["label"] = ""
    client.points[1].payload["label"] = ".env"
    client.points = client.points[:2]
    return FakeAccessor(
        QdrantConfig(collection=COLLECTION,
                     group_by=["label"],
                     text_field="name"), client)


@pytest.fixture
def long_basename() -> FakeAccessor:
    """Two sources whose leaves agree past NAME_MAX and differ at the end."""
    client = FakeQdrantClient()
    client.points[0].payload["source"] = f"s3://docs/{'r' * 300}a.pdf"
    client.points[1].payload["source"] = f"s3://docs/{'r' * 300}b.pdf"
    client.points = client.points[:2]
    return FakeAccessor(
        QdrantConfig(collection=COLLECTION,
                     group_by=["source"],
                     basename_fields=["source"],
                     text_field="name"), client)


WIDE_CAP = 5
WIDE_POINTS = 600


class WideQdrantClient(FakeQdrantClient):
    """A collection far wider than one scroll page, counting pages."""

    def __init__(self) -> None:
        super().__init__()
        self.points = [
            SimpleNamespace(id=i, payload={
                "label": "all",
                "name": f"n{i}"
            }) for i in range(1, WIDE_POINTS + 1)
        ]
        self.pages = 0

    async def scroll(self, *args, **kwargs):
        self.pages += 1
        return await super().scroll(*args, **kwargs)


@pytest.fixture
def capped() -> FakeAccessor:
    return FakeAccessor(
        QdrantConfig(collection=COLLECTION,
                     group_by=["label"],
                     id_field="id",
                     text_field="name",
                     max_rows=WIDE_CAP), WideQdrantClient())


@pytest.fixture
def basename_capped() -> FakeAccessor:
    client = WideQdrantClient()
    for point in client.points:
        point.payload["source"] = f"s3://docs/other-{point.id}.pdf"
    client.points[-1].payload["source"] = "s3://archive/target-late.pdf"
    return FakeAccessor(
        QdrantConfig(collection=COLLECTION,
                     group_by=["source"],
                     basename_fields=["source"],
                     max_rows=WIDE_CAP), client)


@pytest.fixture
def basename_collision_capped() -> FakeAccessor:
    """One basename shared by two sources, the second past the row cap."""
    client = WideQdrantClient()
    for point in client.points:
        point.payload["source"] = "s3://one/report.pdf"
    client.points[-1].payload["source"] = "s3://two/report.pdf"
    return FakeAccessor(
        QdrantConfig(collection=COLLECTION,
                     group_by=["source"],
                     basename_fields=["source"],
                     max_rows=WIDE_CAP), client)


@pytest.fixture
def holds():
    return filter_holds
