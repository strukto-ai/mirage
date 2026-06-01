import pytest

from mirage.core.dify import glob, tree
from mirage.types import PathSpec

from .conftest import list_nested_documents


@pytest.mark.asyncio
async def test_resolve_glob_keeps_unresolved_non_pattern_path(
        monkeypatch, dify_accessor, dify_index):
    monkeypatch.setattr(tree, "list_all_documents", list_nested_documents)
    path = PathSpec(original="/knowledge/guides",
                    directory="/knowledge/guides",
                    resolved=False,
                    prefix="/knowledge/")

    matches = await glob.resolve_glob(dify_accessor, [path], dify_index)

    assert matches == [path]


@pytest.mark.asyncio
async def test_resolve_glob_matches_directory_pattern(monkeypatch,
                                                      dify_accessor,
                                                      dify_index):
    monkeypatch.setattr(tree, "list_all_documents", list_nested_documents)
    path = PathSpec(original="/knowledge/guides/*.md",
                    directory="/knowledge/guides",
                    pattern="quick*",
                    resolved=False,
                    prefix="/knowledge/")

    matches = await glob.resolve_glob(dify_accessor, [path], dify_index)

    assert [item.original
            for item in matches] == ["/knowledge/guides/quickstart"]
    assert matches[0].directory == "/knowledge/guides/"
