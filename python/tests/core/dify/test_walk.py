import pytest

from mirage.core.dify import tree, walk

from .conftest import list_nested_documents, no_documents


@pytest.mark.asyncio
async def test_walk_returns_recursive_paths_with_depth_controls(
        monkeypatch, dify_accessor, dify_index, knowledge_root):
    monkeypatch.setattr(tree, "list_all_documents", list_nested_documents)

    full = await walk.walk(dify_accessor,
                           knowledge_root,
                           dify_index,
                           include_root=True,
                           strip_prefix=True)
    shallow = await walk.walk(dify_accessor,
                              knowledge_root,
                              dify_index,
                              include_root=True,
                              maxdepth=1,
                              strip_prefix=True)

    assert full == [
        "/",
        "/README.md",
        "/guides",
        "/guides/deep",
        "/guides/deep/note",
        "/guides/quickstart",
    ]
    assert shallow == ["/", "/README.md", "/guides"]


@pytest.mark.asyncio
async def test_walk_can_ignore_missing_paths(dify_accessor, dify_index,
                                             guide_path, monkeypatch):
    monkeypatch.setattr(tree, "list_all_documents", no_documents)

    assert await walk.walk(dify_accessor,
                           guide_path,
                           dify_index,
                           ignore_missing=True) == []
