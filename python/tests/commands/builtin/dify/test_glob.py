import pytest

from mirage.commands.builtin.dify.io import resolve_glob
from mirage.core.dify import tree
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from tests.core.dify.conftest import list_nested_documents


@pytest.mark.asyncio
async def test_resolve_glob_keeps_unresolved_non_pattern_path(
        monkeypatch, dify_accessor, dify_index):
    monkeypatch.setattr(tree, "list_all_documents", list_nested_documents)
    path = PathSpec(resource_path=mount_key("/knowledge/guides", "/knowledge"),
                    virtual="/knowledge/guides",
                    directory="/knowledge/guides",
                    resolved=False)

    matches = await resolve_glob(dify_accessor, [path], dify_index)

    assert matches == [path]


@pytest.mark.asyncio
async def test_resolve_glob_matches_directory_pattern(monkeypatch,
                                                      dify_accessor,
                                                      dify_index):
    monkeypatch.setattr(tree, "list_all_documents", list_nested_documents)
    path = PathSpec(resource_path=mount_key("/knowledge/guides/quick*",
                                            "/knowledge"),
                    virtual="/knowledge/guides/quick*",
                    directory="/knowledge/guides",
                    pattern="quick*",
                    resolved=False)

    matches = await resolve_glob(dify_accessor, [path], dify_index)

    assert [item.virtual
            for item in matches] == ["/knowledge/guides/quickstart"]
    assert matches[0].directory == "/knowledge/guides/"
