from types import SimpleNamespace

import pytest

from mirage.cache.index import RAMIndexCacheStore
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


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
                    "content": "api segment",
                    "document": {
                        "name": "API",
                        "doc_metadata": [{
                            "name": "slug",
                            "value": "guides/api"
                        }],
                    },
                },
                "score": 0.92,
            }, {
                "segment": {
                    "content": "auth segment",
                    "document": {
                        "name": "Auth",
                        "doc_metadata": [{
                            "name": "slug",
                            "value": "guides/auth"
                        }],
                    },
                },
                "score": 0.81,
            }]
        }

    monkeypatch.setattr(tree, "list_all_documents", list_documents)
    monkeypatch.setattr(search, "dify_post", dify_post)

    result = await search.search_segments(
        accessor(),
        "login docs",
        [
            PathSpec(resource_path=mount_key("/knowledge/guides",
                                             "/knowledge"),
                     virtual="/knowledge/guides",
                     directory="/knowledge/guides")
        ],
        RAMIndexCacheStore(),
        method="hybrid",
        top_k=2,
        threshold=0.4,
    )

    assert result == (b"/knowledge/guides/api:0.92\napi segment\n"
                      b"/knowledge/guides/auth:0.81\nauth segment\n")
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
            PathSpec(resource_path=mount_key("/knowledge/guides/api",
                                             "/knowledge"),
                     virtual="/knowledge/guides/api",
                     directory="/knowledge/guides/api"),
            PathSpec(resource_path=mount_key("/knowledge/README.md",
                                             "/knowledge"),
                     virtual="/knowledge/README.md",
                     directory="/knowledge/README.md"),
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
            PathSpec(resource_path=mount_key("/knowledge/guides/api",
                                             "/knowledge"),
                     virtual="/knowledge/guides/api",
                     directory="/knowledge/guides/api")
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
        return {
            "records": [{
                "segment": {
                    "content": "dataset match",
                    "document": {
                        "name": "README.md",
                        "doc_metadata": None,
                    },
                },
                "score": 0.77,
            }]
        }

    monkeypatch.setattr(search, "dify_post", dify_post)

    result = await search.search_segments(accessor(),
                                          "anything", [],
                                          RAMIndexCacheStore(),
                                          mount_prefix="/knowledge/")

    assert result == b"/knowledge/README.md:0.77\ndataset match\n"
    assert "metadata_filtering_conditions" not in bodies[0]["retrieval_model"]


def test_records_to_bytes_formats_absolute_paths_and_scores():
    from mirage.core.dify.search import records_to_bytes

    result = records_to_bytes(
        [{
            "segment": {
                "content": "api segment",
                "document": {
                    "name": "API",
                    "doc_metadata": [{
                        "name": "slug",
                        "value": "guides/api"
                    }],
                },
            },
            "score": 0.92,
        }, {
            "segment": {
                "content": "auth segment",
                "document": {
                    "name": "README.md",
                    "doc_metadata": None,
                },
            },
        }],
        "slug",
        "/knowledge/",
    )

    assert result == (b"/knowledge/guides/api:0.92\napi segment\n"
                      b"/knowledge/README.md\nauth segment\n")


@pytest.mark.parametrize("value", [None, {}, ["invalid"]])
def test_response_records_rejects_malformed_payload(value):
    from mirage.core.dify.search import response_records

    with pytest.raises(ValueError, match="records must be"):
        response_records(value)


def test_records_to_bytes_keeps_multiple_chunks_for_same_document():
    from mirage.core.dify.search import records_to_bytes

    result = records_to_bytes(
        [{
            "segment": {
                "content": "first chunk",
                "document": {
                    "name":
                    "refunds.md",
                    "doc_metadata": [{
                        "name": "slug",
                        "value": "policies/refunds"
                    }],
                },
            },
            "score": 0.82,
        }, {
            "segment": {
                "content": "second chunk",
                "document": {
                    "name":
                    "refunds.md",
                    "doc_metadata": [{
                        "name": "slug",
                        "value": "policies/refunds"
                    }],
                },
            },
            "score": 0.79,
        }],
        "slug",
        "/knowledge/",
    )

    assert result == (b"/knowledge/policies/refunds:0.82\nfirst chunk\n"
                      b"/knowledge/policies/refunds:0.79\nsecond chunk\n")


def test_records_to_bytes_skips_records_with_invalid_slug():
    from mirage.core.dify.search import records_to_bytes

    result = records_to_bytes(
        [{
            "segment": {
                "content": "bad chunk",
                "document": {
                    "name": "ok.md",
                    "doc_metadata": [{
                        "name": "slug",
                        "value": ""
                    }],
                },
            },
            "score": 0.82,
        }, {
            "segment": {
                "content": "good chunk",
                "document": {
                    "name":
                    "refunds.md",
                    "doc_metadata": [{
                        "name": "slug",
                        "value": "policies/refunds"
                    }],
                },
            },
            "score": 0.79,
        }],
        "slug",
        "/knowledge/",
    )

    assert result == b"/knowledge/policies/refunds:0.79\ngood chunk\n"


def test_records_to_bytes_omits_score_for_non_numeric_values():
    from mirage.core.dify.search import records_to_bytes

    result = records_to_bytes(
        [{
            "segment": {
                "content": "chunk",
                "document": {
                    "name":
                    "refunds.md",
                    "doc_metadata": [{
                        "name": "slug",
                        "value": "policies/refunds"
                    }],
                },
            },
            "score": True,
        }],
        "slug",
        "/knowledge/",
    )

    assert result == b"/knowledge/policies/refunds\nchunk\n"


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
