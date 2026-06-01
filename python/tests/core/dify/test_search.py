from types import SimpleNamespace

import pytest

from mirage.cache.index import RAMIndexCacheStore
from mirage.types import PathSpec


def document(document_id: str, name: str, slug: str | None = None) -> dict:
    metadata = []
    if slug is not None:
        metadata = [{"name": "slug", "value": slug}]
    return {
        "id": document_id,
        "name": name,
        "doc_metadata": metadata,
        "enabled": True,
        "indexing_status": "completed",
        "archived": False,
        "tokens": 4,
        "data_source_type": "upload_file",
        "data_source_detail_dict": {
            "upload_file": {
                "size": 12
            }
        },
        "created_at": 1716282000,
    }


def accessor() -> SimpleNamespace:
    return SimpleNamespace(config=SimpleNamespace(dataset_id="dataset-1",
                                                  slug_metadata_name="slug"))


def custom_slug_accessor() -> SimpleNamespace:
    return SimpleNamespace(config=SimpleNamespace(dataset_id="dataset-1",
                                                  slug_metadata_name="path"))


custom_slug_search_bodies: list[dict] = []


async def list_path_metadata_documents(config):
    return [{
        **document("doc-1", "API"), "doc_metadata": [{
            "name": "path",
            "value": "guides/api"
        }]
    }]


async def record_empty_custom_slug_search(config, endpoint, body):
    custom_slug_search_bodies.append(body)
    return {"records": []}


@pytest.mark.asyncio
async def test_search_segments_scopes_folder_to_all_documents(monkeypatch):
    from mirage.core.dify import search, tree

    bodies: list[dict] = []

    async def list_documents(config):
        return [
            document("doc-1", "API", "guides/api"),
            document("doc-2", "Auth", "guides/auth"),
            document("doc-3", "README.md"),
        ]

    async def dify_post(config, endpoint, body):
        bodies.append(body)
        return {
            "records": [{
                "segment": {
                    "content": "api segment"
                }
            }, {
                "segment": {
                    "content": "auth segment"
                }
            }]
        }

    monkeypatch.setattr(tree, "list_all_documents", list_documents)
    monkeypatch.setattr(search, "dify_post", dify_post)

    result = await search.search_segments(
        accessor(),
        "login docs",
        [
            PathSpec(original="/knowledge/guides",
                     directory="/knowledge/guides",
                     prefix="/knowledge/")
        ],
        RAMIndexCacheStore(),
        method="hybrid",
        top_k=2,
        threshold=0.4,
    )

    assert result == b"api segment\nauth segment"
    retrieval = bodies[0]["retrieval_model"]
    assert retrieval["search_method"] == "hybrid_search"
    assert retrieval["top_k"] == 2
    assert retrieval["score_threshold_enabled"] is True
    assert retrieval["score_threshold"] == 0.4
    assert retrieval["metadata_filtering_conditions"] == {
        "logical_operator":
        "or",
        "conditions": [{
            "name": "slug",
            "comparison_operator": "in",
            "value": ["guides/api", "guides/auth"],
        }],
    }


@pytest.mark.asyncio
async def test_search_segments_unions_slug_and_name_based_paths(monkeypatch):
    from mirage.core.dify import search, tree

    bodies: list[dict] = []

    async def list_documents(config):
        return [
            document("doc-1", "API", "guides/api"),
            document("doc-2", "README.md"),
        ]

    async def dify_post(config, endpoint, body):
        bodies.append(body)
        return {"records": []}

    monkeypatch.setattr(tree, "list_all_documents", list_documents)
    monkeypatch.setattr(search, "dify_post", dify_post)

    result = await search.search_segments(
        accessor(),
        "setup",
        [
            PathSpec(original="/knowledge/guides/api",
                     directory="/knowledge/guides/api",
                     prefix="/knowledge/"),
            PathSpec(original="/knowledge/README.md",
                     directory="/knowledge/README.md",
                     prefix="/knowledge/"),
        ],
        RAMIndexCacheStore(),
    )

    assert result == b""
    assert bodies[0]["retrieval_model"]["metadata_filtering_conditions"] == {
        "logical_operator":
        "or",
        "conditions": [{
            "name": "slug",
            "comparison_operator": "in",
            "value": ["guides/api"],
        }, {
            "name": "document_name",
            "comparison_operator": "in",
            "value": ["README.md"],
        }],
    }


@pytest.mark.asyncio
async def test_search_segments_uses_configured_slug_metadata_name(monkeypatch):
    from mirage.core.dify import search, tree

    custom_slug_search_bodies.clear()
    monkeypatch.setattr(tree, "list_all_documents",
                        list_path_metadata_documents)
    monkeypatch.setattr(search, "dify_post", record_empty_custom_slug_search)

    await search.search_segments(
        custom_slug_accessor(),
        "setup",
        [
            PathSpec(original="/knowledge/guides/api",
                     directory="/knowledge/guides/api",
                     prefix="/knowledge/")
        ],
        RAMIndexCacheStore(),
    )

    assert custom_slug_search_bodies[0]["retrieval_model"][
        "metadata_filtering_conditions"] == {
            "logical_operator":
            "or",
            "conditions": [{
                "name": "path",
                "comparison_operator": "in",
                "value": ["guides/api"],
            }],
        }


@pytest.mark.asyncio
async def test_search_segments_empty_paths_searches_whole_dataset(monkeypatch):
    from mirage.core.dify import search

    bodies: list[dict] = []

    async def dify_post(config, endpoint, body):
        bodies.append(body)
        return {"records": [{"segment": {"content": "dataset match"}}]}

    monkeypatch.setattr(search, "dify_post", dify_post)

    result = await search.search_segments(accessor(), "anything", [],
                                          RAMIndexCacheStore())

    assert result == b"dataset match"
    assert "metadata_filtering_conditions" not in bodies[0]["retrieval_model"]


@pytest.mark.asyncio
async def test_search_segments_caps_top_k_at_dify_limit(monkeypatch):
    from mirage.core.dify import search

    bodies: list[dict] = []

    async def dify_post(config, endpoint, body):
        bodies.append(body)
        return {"records": []}

    monkeypatch.setattr(search, "dify_post", dify_post)

    await search.search_segments(accessor(),
                                 "anything", [],
                                 RAMIndexCacheStore(),
                                 top_k=150)

    assert bodies[0]["retrieval_model"]["top_k"] == 100


@pytest.mark.asyncio
async def test_search_segments_validates_arguments():
    from mirage.core.dify.search import search_segments

    with pytest.raises(ValueError, match="search: query is required"):
        await search_segments(accessor(), "", [], RAMIndexCacheStore())
    with pytest.raises(ValueError, match="search: top-k must be positive"):
        await search_segments(accessor(),
                              "x", [],
                              RAMIndexCacheStore(),
                              top_k=0)
    with pytest.raises(ValueError, match="search: threshold must be in"):
        await search_segments(accessor(),
                              "x", [],
                              RAMIndexCacheStore(),
                              threshold=1.2)
    with pytest.raises(ValueError, match="search: method must be one of"):
        await search_segments(accessor(),
                              "x", [],
                              RAMIndexCacheStore(),
                              method="bad")
