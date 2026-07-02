from types import SimpleNamespace

import pytest

from mirage.cache.index import RAMIndexCacheStore
from mirage.io.types import materialize
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
    return SimpleNamespace(config=SimpleNamespace(slug_metadata_name="slug"))


@pytest.mark.asyncio
async def test_search_command_resolves_globs_and_passes_multiple_documents(
        monkeypatch):
    from mirage.commands.builtin.dify import search as command_search
    from mirage.core.dify import search, tree

    calls: list[tuple[list[PathSpec], dict]] = []

    async def list_documents(config):
        return [
            document("doc-1", "API", "guides/api.md"),
            document("doc-2", "Auth", "guides/auth.md"),
        ]

    async def search_segments(accessor, query, paths, index, **kwargs):
        calls.append((paths, kwargs))
        return b"api\nauth"

    monkeypatch.setattr(tree, "list_all_documents", list_documents)
    monkeypatch.setattr(search, "search_segments", search_segments)

    stdout, io = await command_search(
        accessor(),
        [
            PathSpec(resource_path=mount_key("/knowledge/guides/*.md",
                                             "/knowledge"),
                     virtual="/knowledge/guides/*.md",
                     directory="/knowledge/guides",
                     pattern="*.md",
                     resolved=False)
        ],
        "login",
        index=RAMIndexCacheStore(),
    )

    assert await materialize(stdout) == b"api\nauth"
    assert io.reads == {}
    assert io.cache == []
    assert [path.virtual for path in calls[0][0]] == [
        "/knowledge/guides/api.md",
        "/knowledge/guides/auth.md",
    ]
    assert calls[0][1]["mount_prefix"] == "/knowledge"


@pytest.mark.asyncio
async def test_search_command_root_searches_whole_dataset(monkeypatch):
    from mirage.commands.builtin.dify import search as command_search
    from mirage.core.dify import search

    calls: list[tuple[list[PathSpec], dict]] = []

    async def search_segments(accessor, query, paths, index, **kwargs):
        calls.append((paths, kwargs))
        return b"dataset"

    monkeypatch.setattr(search, "search_segments", search_segments)
    root = PathSpec(resource_path=mount_key("/knowledge", "/knowledge"),
                    virtual="/knowledge",
                    directory="/knowledge")

    stdout, _ = await command_search(accessor(), [root],
                                     "anything",
                                     index=RAMIndexCacheStore())

    assert await materialize(stdout) == b"dataset"
    assert calls == [([], {
        "method": "semantic",
        "top_k": 10,
        "threshold": 0.0,
        "mount_prefix": "/knowledge"
    })]
