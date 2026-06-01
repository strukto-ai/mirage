import pytest

from mirage.commands.builtin.dify.rg import rg
from mirage.core.dify import read, tree
from mirage.io.types import materialize

from .conftest import document


async def list_documents(config):
    return [
        document("doc-1", "Guide", "guides/quickstart.md"),
        document("doc-2", "Api", "guides/api.md"),
    ]


async def iter_pages(config, document_id):
    if document_id == "doc-1":
        yield [{"content": "alpha\nbeta"}]
    else:
        yield [{"content": "gamma alpha"}]


async def get_segments(config, document_id):
    if document_id == "doc-1":
        return [{"content": "alpha\nbeta"}]
    return [{"content": "gamma alpha"}]


@pytest.mark.asyncio
async def test_rg_searches_dify_documents(monkeypatch, dify_accessor,
                                          dify_index, guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_documents)
    monkeypatch.setattr(read, "iter_segment_pages", iter_pages)
    monkeypatch.setattr(read, "get_document_segments", get_segments)

    stdout, io = await rg(dify_accessor, [guide_path],
                          "alpha",
                          index=dify_index)

    assert await materialize(stdout) == b"alpha\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_rg_supports_line_numbers_and_files_only(monkeypatch,
                                                       dify_accessor,
                                                       dify_index,
                                                       knowledge_root):
    monkeypatch.setattr(tree, "list_all_documents", list_documents)
    monkeypatch.setattr(read, "get_document_segments", get_segments)

    numbered_stdout, _ = await rg(dify_accessor, [knowledge_root],
                                  "alpha",
                                  n=True,
                                  index=dify_index)
    numbered_text = (await materialize(numbered_stdout)).decode()
    assert "/knowledge/guides/quickstart.md:1:alpha" in numbered_text
    assert "/knowledge/guides/api.md:1:gamma alpha" in numbered_text

    files_stdout, _ = await rg(dify_accessor, [knowledge_root],
                               "alpha",
                               args_l=True,
                               index=dify_index)
    assert await materialize(files_stdout) == (
        b"/knowledge/guides/api.md\n"
        b"/knowledge/guides/quickstart.md\n")
