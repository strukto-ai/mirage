from types import SimpleNamespace

import pytest

from mirage.commands.builtin.dify import search as command_search
from mirage.commands.config import Context
from mirage.core.dify import search, tree
from mirage.io.types import materialize
from mirage.types import PathSpec, SearchQuery
from mirage.utils.key_prefix import mount_key
from mirage.vfs.dify import DifyVFS
from mirage.workspace import Workspace
from mirage.workspace.files import Files
from tests.fixtures.mount_commands import command_files
from tests.fixtures.vfs_io import StubAccessor, vfs_over


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


def accessor() -> StubAccessor:
    return StubAccessor(config=SimpleNamespace(slug_metadata_name="slug"))


def _files() -> Files:
    """The files of a line on a workspace with the store at /knowledge,
    whose search the command sends through the dispatcher."""
    return command_files(
        Workspace({"/knowledge/": vfs_over(DifyVFS, accessor())})
    )


async def _list_documents(config):
    return [
        document("doc-1", "API", "guides/api.md"),
        document("doc-2", "Auth", "guides/auth.md"),
    ]


@pytest.mark.asyncio
async def test_search_resolves_globs_and_passes_multiple_documents(
    monkeypatch,
):

    calls: list[tuple[list[PathSpec], dict]] = []

    async def search_segments(accessor, query, paths, **kwargs):
        calls.append((paths, kwargs))
        return [("/knowledge/a", "api"), ("/knowledge/b", "auth")]

    monkeypatch.setattr(tree, "list_all_documents", _list_documents)
    monkeypatch.setattr(search, "search_segments", search_segments)

    # The store resolves a glob scope itself, as a batch ranking does.
    hits = await vfs_over(DifyVFS, accessor()).search_many(
        [
            PathSpec(
                vfs_path=mount_key("/knowledge/guides/*.md", "/knowledge"),
                virtual="/knowledge/guides/*.md",
                directory="/knowledge/guides",
                pattern="*.md",
                resolved=False,
            )
        ],
        SearchQuery("login", options={"method": "semantic"}),
    )
    stdout = "".join(record + "\n" for _, record in hits or []).encode()

    assert stdout == b"api\nauth\n"
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
        Context(vfs=_files()),
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
        Context(flags={"method": ""}, vfs=_files()),
    )

    assert calls[0]["method"] == ""
