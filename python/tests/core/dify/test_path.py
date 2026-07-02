import pytest

from mirage.cache.index.config import IndexEntry
from mirage.core.dify import path
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

from .conftest import folder_entry, noop_ensure_tree


@pytest.mark.asyncio
async def test_resolve_path_finds_files_and_directories(
        monkeypatch, dify_accessor, dify_index):
    monkeypatch.setattr(path, "ensure_tree", noop_ensure_tree)
    await dify_index.set_dir(
        "/knowledge",
        [
            ("guides", folder_entry("guides")),
            ("README.md",
             IndexEntry(id="doc-1", name="README.md", resource_type="file")),
        ],
    )
    await dify_index.set_dir("/knowledge/guides", [])

    file_result = await path.resolve_path(
        dify_accessor,
        PathSpec.from_str_path("/knowledge/README.md",
                               mount_key("/knowledge/README.md",
                                         "/knowledge")),
        dify_index,
    )
    dir_result = await path.resolve_path(
        dify_accessor,
        PathSpec.from_str_path("/knowledge/guides",
                               mount_key("/knowledge/guides", "/knowledge")),
        dify_index,
    )

    assert file_result.virtual_key == "/knowledge/README.md"
    assert file_result.is_dir is False
    assert file_result.entry is not None
    assert dir_result.virtual_key == "/knowledge/guides"
    assert dir_result.is_dir is True
    assert dir_result.entry is not None
    assert dir_result.entry.resource_type == "folder"


@pytest.mark.asyncio
async def test_resolve_path_raises_missing(monkeypatch, dify_accessor,
                                           dify_index):
    monkeypatch.setattr(path, "ensure_tree", noop_ensure_tree)
    await dify_index.set_dir("/knowledge", [])

    with pytest.raises(FileNotFoundError):
        await path.resolve_path(
            dify_accessor,
            PathSpec.from_str_path(
                "/knowledge/missing",
                mount_key("/knowledge/missing", "/knowledge")),
            dify_index,
        )


def test_virtual_key_for_honors_prefix_and_patterns():
    assert path.virtual_key_for(
        PathSpec.from_str_path(
            "/knowledge/guides/quickstart",
            "guides/quickstart")) == "/knowledge/guides/quickstart"
    assert path.virtual_key_for(
        PathSpec(resource_path=mount_key("/knowledge/guides/*.md",
                                         "/knowledge"),
                 virtual="/knowledge/guides/*.md",
                 directory="/knowledge/guides",
                 pattern="*.md")) == "/knowledge/guides"
