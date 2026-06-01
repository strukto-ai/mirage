import pytest

from mirage.commands.builtin.dify.wc import wc
from mirage.core.dify import read, tree
from mirage.io.types import materialize

from .conftest import document


async def list_single_document(config):
    return [document("doc-1", "Guide", "guides/quickstart.md")]


async def get_basic_segments(config, document_id):
    return [{"content": "alpha\nbeta"}, {"content": "gamma"}]


async def get_multibyte_segments(config, document_id):
    return [{"content": "xin\nchaoo\nbanh mi"}]


@pytest.mark.asyncio
async def test_wc_counts_document(monkeypatch, dify_accessor, dify_index,
                                  guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_single_document)
    monkeypatch.setattr(read, "get_document_segments", get_basic_segments)

    stdout, io = await wc(dify_accessor, [guide_path], index=dify_index)

    assert await materialize(stdout) == (
        b"2\t3\t16\t/knowledge/guides/quickstart.md\n")
    assert io.cache == [guide_path.original]


@pytest.mark.asyncio
async def test_wc_supports_chars_and_max_line_length(monkeypatch,
                                                     dify_accessor, dify_index,
                                                     guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_single_document)
    monkeypatch.setattr(read, "get_document_segments", get_multibyte_segments)

    chars_stdout, _ = await wc(dify_accessor, [guide_path],
                               m=True,
                               index=dify_index)
    assert await materialize(chars_stdout) == (
        b"17\t/knowledge/guides/quickstart.md\n")

    max_line_stdout, _ = await wc(dify_accessor, [guide_path],
                                  L=True,
                                  index=dify_index)
    assert await materialize(max_line_stdout) == (
        b"7\t/knowledge/guides/quickstart.md\n")
