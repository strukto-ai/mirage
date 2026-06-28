import base64
from difflib import SequenceMatcher
from types import SimpleNamespace

import pytest

from mirage.resource.qdrant.config import QdrantConfig

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


def _match(point: SimpleNamespace, scroll_filter) -> bool:
    if scroll_filter is None:
        return True
    for condition in scroll_filter.must:
        value = (point.payload or {}).get(condition.key)
        if str(value) != str(condition.match.value):
            return False
    return True


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
        matched = [p for p in self.points if _match(p, scroll_filter)]
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
