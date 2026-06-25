import pytest

from mirage.core.dify import find, stat, tree
from mirage.types import FindType

from .conftest import list_nested_documents


async def get_detail(config, document_id):
    sizes = {
        "doc-1": 333,
        "doc-2": 20,
        "doc-3": 10,
    }
    return {
        "id": document_id,
        "updated_at": 1716285600,
        "data_source_info": {
            "upload_file": {
                "size": sizes[document_id]
            }
        },
    }


@pytest.mark.asyncio
async def test_find_name_matches_mount_root_start_path(monkeypatch,
                                                       dify_accessor,
                                                       dify_index,
                                                       knowledge_root):
    monkeypatch.setattr(tree, "list_all_documents", list_nested_documents)
    monkeypatch.setattr(stat, "get_document_detail", get_detail)
    results = await find.find(dify_accessor,
                              knowledge_root,
                              name="knowledge",
                              index=dify_index)
    assert results == ["/knowledge"]


@pytest.mark.asyncio
async def test_find_filters_name_type_size_and_depth(monkeypatch,
                                                     dify_accessor, dify_index,
                                                     knowledge_root):
    monkeypatch.setattr(tree, "list_all_documents", list_nested_documents)
    monkeypatch.setattr(stat, "get_document_detail", get_detail)

    named = await find.find(dify_accessor,
                            knowledge_root,
                            name="quick*",
                            index=dify_index)
    assert named == ["guides/quickstart"]

    directories = await find.find(dify_accessor,
                                  knowledge_root,
                                  type=FindType.DIRECTORY,
                                  index=dify_index)
    assert directories == ["/knowledge", "guides", "guides/deep"]

    large_files = await find.find(dify_accessor,
                                  knowledge_root,
                                  type=FindType.FILE,
                                  min_size=100,
                                  index=dify_index)
    assert large_files == ["guides/quickstart"]

    deep = await find.find(dify_accessor,
                           knowledge_root,
                           mindepth=2,
                           index=dify_index)
    assert "/" not in deep
    assert "guides" not in deep
    assert "guides/deep" in deep
