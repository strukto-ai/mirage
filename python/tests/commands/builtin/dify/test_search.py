from types import SimpleNamespace

import pytest

from mirage.cache.index import RAMIndexCacheStore
from mirage.commands.builtin.dify import search as command_search
from mirage.commands.config import Context
from mirage.core.dify import search, tree
from mirage.io.types import materialize
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.dify import DifyVFS
from tests.fixtures.vfs_io import io_for


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
        "data_source_detail_dict": {"upload_file": {"size": 12}},
        "created_at": 1716282000,
    }


def accessor() -> SimpleNamespace:
    return SimpleNamespace(config=SimpleNamespace(slug_metadata_name="slug"))


@pytest.mark.asyncio
async def test_search_command_resolves_globs_and_passes_multiple_documents(
    monkeypatch,
):

    calls: list[tuple[list[PathSpec], dict]] = []

    async def list_documents(config):
        return [
            document("doc-1", "API", "guides/api.md"),
            document("doc-2", "Auth", "guides/auth.md"),
        ]

    async def search_segments(accessor, query, paths, **kwargs):
        calls.append((paths, kwargs))
        return [("/knowledge/a", "api"), ("/knowledge/b", "auth")]

    monkeypatch.setattr(tree, "list_all_documents", list_documents)
    monkeypatch.setattr(search, "search_segments", search_segments)

    stdout, io = await command_search(
        accessor(),
        [
            PathSpec(
                vfs_path=mount_key("/knowledge/guides/*.md", "/knowledge"),
                virtual="/knowledge/guides/*.md",
                directory="/knowledge/guides",
                pattern="*.md",
                resolved=False,
            )
        ],
        ["login"],
        Context(io=io_for(DifyVFS, accessor()), index=RAMIndexCacheStore()),
    )

    assert await materialize(stdout) == b"api\nauth\n"
    assert [path.virtual for path in calls[0][0]] == [
        "/knowledge/guides/api.md",
        "/knowledge/guides/auth.md",
    ]
    assert calls[0][1]["mount_prefix"] == "/knowledge"


@pytest.mark.asyncio
async def test_search_command_root_searches_whole_dataset(monkeypatch):

    calls: list[tuple[list[PathSpec], dict]] = []

    async def search_segments(accessor, query, paths, **kwargs):
        calls.append((paths, kwargs))
        return [("/knowledge/a", "dataset")]

    monkeypatch.setattr(search, "search_segments", search_segments)
    root = PathSpec(
        vfs_path=mount_key("/knowledge", "/knowledge"),
        virtual="/knowledge",
        directory="/knowledge",
    )

    stdout, _ = await command_search(
        accessor(),
        [root],
        ["anything"],
        Context(io=io_for(DifyVFS, accessor()), index=RAMIndexCacheStore()),
    )

    assert await materialize(stdout) == b"dataset\n"
    assert calls == [
        (
            [],
            {
                "method": "semantic",
                "top_k": 10,
                "threshold": 0.0,
                "mount_prefix": "/knowledge",
            },
        )
    ]


@pytest.mark.asyncio
async def test_search_command_sends_an_explicit_empty_method(monkeypatch):

    calls: list[dict] = []

    async def search_segments(accessor, query, paths, **kwargs):
        calls.append(kwargs)
        return []

    monkeypatch.setattr(search, "search_segments", search_segments)
    root = PathSpec(
        vfs_path=mount_key("/knowledge", "/knowledge"),
        virtual="/knowledge",
        directory="/knowledge",
    )

    await command_search(
        accessor(),
        [root],
        ["anything"],
        Context(
            flags={"method": ""},
            io=io_for(DifyVFS, accessor()),
            index=RAMIndexCacheStore(),
        ),
    )

    assert calls[0]["method"] == ""
