import pytest

from mirage.commands.builtin.dify.stat import stat
from mirage.core.dify import stat as stat_core
from mirage.core.dify import tree
from mirage.io.types import materialize

from .conftest import document


async def list_documents(config):
    return [document("doc-1", "Guide", "guides/quickstart.md", size=17)]


async def get_detail(config, document_id):
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


@pytest.mark.asyncio
async def test_stat_prints_dify_metadata(monkeypatch, dify_accessor,
                                         dify_index, guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_documents)
    monkeypatch.setattr(stat_core, "get_document_detail", get_detail)

    stdout, io = await stat(dify_accessor, [guide_path], index=dify_index)

    assert await materialize(stdout) == (
        b"name=quickstart.md size=17 modified=2024-05-21T10:00:00Z "
        b"type=text\n")
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_stat_supports_format(monkeypatch, dify_accessor, dify_index,
                                    guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_documents)
    monkeypatch.setattr(stat_core, "get_document_detail", get_detail)

    stdout, _ = await stat(dify_accessor, [guide_path],
                           c="%n %s %F",
                           index=dify_index)

    assert await materialize(stdout) == (b"/knowledge/guides/quickstart.md"
                                         b" 17 regular file\n")
