import pytest

from mirage.commands.builtin.dify.ls import ls
from mirage.core.dify import stat, tree
from mirage.io.types import materialize
from mirage.types import PathSpec

from .conftest import document


async def list_basic_documents(config):
    return [
        document("doc-1", "Guide", "guides/quickstart.md"),
        document("doc-2", "Readme", "README.md"),
    ]


async def get_detail(config, document_id):
    if document_id == "doc-1":
        return {
            "id": document_id,
            "updated_at": 1716285600,
            "data_source_info": {
                "upload_file": {
                    "size": 17
                }
            },
            "tokens": 4,
            "indexing_status": "completed",
        }
    return {
        "id": document_id,
        "updated_at": 1716285601,
        "data_source_info": {
            "upload_file": {
                "size": 6
            }
        },
        "tokens": 4,
        "indexing_status": "completed",
    }


@pytest.mark.asyncio
async def test_ls_lists_virtual_tree(monkeypatch, dify_accessor, dify_index,
                                     knowledge_root):
    monkeypatch.setattr(tree, "list_all_documents", list_basic_documents)
    monkeypatch.setattr(stat, "get_document_detail", get_detail)

    stdout, _ = await ls(dify_accessor, [knowledge_root], index=dify_index)

    assert await materialize(stdout) == b"README.md\nguides"


@pytest.mark.asyncio
async def test_ls_uses_cwd_and_supports_list_dir(monkeypatch, dify_accessor,
                                                 dify_index, guides_path):
    monkeypatch.setattr(tree, "list_all_documents", list_basic_documents)
    monkeypatch.setattr(stat, "get_document_detail", get_detail)

    cwd_stdout, cwd_io = await ls(dify_accessor, [],
                                  index=dify_index,
                                  cwd=guides_path)
    assert await materialize(cwd_stdout) == b"quickstart.md"
    assert cwd_io.exit_code == 0

    dir_stdout, dir_io = await ls(dify_accessor, [guides_path],
                                  d=True,
                                  index=dify_index)
    assert await materialize(dir_stdout) == b"guides"
    assert dir_io.exit_code == 0


@pytest.mark.asyncio
async def test_ls_resolves_glob_patterns(monkeypatch, dify_accessor,
                                         dify_index):
    monkeypatch.setattr(tree, "list_all_documents", list_basic_documents)
    monkeypatch.setattr(stat, "get_document_detail", get_detail)
    path = PathSpec(original="/knowledge/*.md",
                    directory="/knowledge",
                    pattern="*.md",
                    resolved=False,
                    prefix="/knowledge/")

    stdout, io = await ls(dify_accessor, [path], d=True, index=dify_index)

    assert await materialize(stdout) == b"README.md"
    assert io.exit_code == 0
