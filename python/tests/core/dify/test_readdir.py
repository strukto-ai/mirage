import pytest

from mirage.core.dify import readdir, tree

from .conftest import list_basic_documents


@pytest.mark.asyncio
async def test_readdir_returns_directory_children(monkeypatch, dify_accessor,
                                                  dify_index, knowledge_root):
    monkeypatch.setattr(tree, "list_all_documents", list_basic_documents)

    children = await readdir.readdir(dify_accessor, knowledge_root, dify_index)

    assert children == ["/knowledge/README.md", "/knowledge/guides"]


@pytest.mark.asyncio
async def test_readdir_rejects_files(monkeypatch, dify_accessor, dify_index,
                                     guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_basic_documents)

    with pytest.raises(NotADirectoryError):
        await readdir.readdir(dify_accessor, guide_path, dify_index)
