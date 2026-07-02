import json
from functools import partial
from types import SimpleNamespace

import pytest

from mirage.cache.index import RAMIndexCacheStore
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


class FakeCollection:

    def __init__(self) -> None:
        self.documents: dict[str, str] = {}
        self.chunks: dict[str, list[dict]] = {}
        self.get_calls: list[dict] = []
        self.queries: list[dict] = []
        self.contains_queries: list[dict] = []

    async def get(self, **kwargs):
        self.get_calls.append(kwargs)
        ids = kwargs.get("ids")
        if ids == ["__path_tree__"]:
            return {"documents": [self.documents["__path_tree__"]]}

        where = kwargs.get("where") or {}
        slug = where.get("page_slug")
        if isinstance(slug, dict):
            slug = slug.get("$eq")
        if slug is not None:
            chunks = self.chunks.get(slug, [])
            offset = kwargs.get("offset") or 0
            limit = kwargs.get("limit")
            if limit is not None:
                chunks = chunks[offset:offset + limit]
            elif offset:
                chunks = chunks[offset:]
            return {
                "documents": [item["document"] for item in chunks],
                "metadatas": [item["metadata"] for item in chunks],
            }

        where_document = kwargs.get("where_document") or {}
        if "$contains" in where_document or "$regex" in where_document:
            self.contains_queries.append(kwargs)
            candidates = where.get("page_slug", {}).get("$in", [])
            pattern = where_document.get("$contains") or where_document.get(
                "$regex")
            docs: list[str] = []
            metadatas: list[dict] = []
            for slug_item in candidates:
                for chunk in self.chunks.get(slug_item, []):
                    if pattern in chunk["document"]:
                        docs.append(chunk["document"])
                        metadatas.append(chunk["metadata"])
            return {"documents": docs, "metadatas": metadatas}

        return {"documents": [], "metadatas": []}

    async def query(self, **kwargs):
        self.queries.append(kwargs)
        return {
            "documents": [["quickstart chunk", "api chunk"]],
            "metadatas": [[{
                "page_slug": "guides/quickstart"
            }, {
                "page_slug": "api/reference"
            }]],
            "distances": [[0.1, 0.25]],
        }


def path_tree_document() -> str:
    return json.dumps({
        "guides/quickstart": {
            "size": 12,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-02-01T00:00:00Z",
        },
        "api/reference": {
            "size": None,
            "created_at": None,
            "updated_at": None,
        },
    })


@pytest.fixture
def chroma_collection() -> FakeCollection:
    collection = FakeCollection()
    collection.documents["__path_tree__"] = path_tree_document()
    collection.chunks["guides/quickstart"] = [
        {
            "document": "second",
            "metadata": {
                "page_slug": "guides/quickstart",
                "chunk_index": 2,
            },
        },
        {
            "document": "first",
            "metadata": {
                "page_slug": "guides/quickstart",
                "chunk_index": 1,
            },
        },
    ]
    collection.chunks["api/reference"] = [{
        "document": "api",
        "metadata": {
            "page_slug": "api/reference",
            "chunk_index": 0,
        },
    }]
    return collection


async def _get_collection(collection):
    return collection


@pytest.fixture
def chroma_accessor(chroma_collection) -> SimpleNamespace:
    return SimpleNamespace(
        config=SimpleNamespace(slug_field="page_slug",
                               chunk_index_field="chunk_index"),
        collection=chroma_collection,
        get_collection=partial(_get_collection, chroma_collection))


@pytest.fixture
def chroma_index() -> RAMIndexCacheStore:
    return RAMIndexCacheStore()


@pytest.fixture
def knowledge_root() -> PathSpec:
    return PathSpec(resource_path=mount_key("/knowledge", "/knowledge"),
                    virtual="/knowledge",
                    directory="/knowledge")


@pytest.fixture
def quickstart_path() -> PathSpec:
    return PathSpec.from_str_path(
        "/knowledge/guides/quickstart",
        mount_key("/knowledge/guides/quickstart", "/knowledge"))
