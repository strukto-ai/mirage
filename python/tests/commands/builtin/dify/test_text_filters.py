import pytest

from mirage.commands.builtin.dify.awk import awk
from mirage.commands.builtin.dify.cut import cut
from mirage.commands.builtin.dify.sort import sort
from mirage.commands.builtin.dify.uniq import uniq
from mirage.core.dify import read, tree
from mirage.io.types import materialize

from .conftest import document


async def list_documents(config):
    return [document("doc-1", "Guide", "guides/quickstart.md")]


async def iter_pages(config, document_id):
    yield [{"content": "beta 2\nalpha 1\nalpha 1"}]


async def get_segments(config, document_id):
    return [{"content": "beta 2\nalpha 1\nalpha 1"}]


@pytest.mark.asyncio
async def test_awk_filters_dify_document(monkeypatch, dify_accessor,
                                         dify_index, guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_documents)
    monkeypatch.setattr(read, "get_document_segments", get_segments)
    monkeypatch.setattr(read, "iter_segment_pages", iter_pages)

    stdout, _ = await awk(dify_accessor, [guide_path],
                          "/alpha/ {print $2}",
                          index=dify_index)

    assert await materialize(stdout) == b"1\n1\n"


@pytest.mark.asyncio
async def test_cut_extracts_fields(monkeypatch, dify_accessor, dify_index,
                                   guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_documents)
    monkeypatch.setattr(read, "iter_segment_pages", iter_pages)

    stdout, _ = await cut(dify_accessor, [guide_path],
                          f="1",
                          d=" ",
                          index=dify_index)

    assert await materialize(stdout) == b"beta\nalpha\nalpha\n"


@pytest.mark.asyncio
async def test_sort_and_uniq_process_document(monkeypatch, dify_accessor,
                                              dify_index, guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_documents)
    monkeypatch.setattr(read, "get_document_segments", get_segments)
    monkeypatch.setattr(read, "iter_segment_pages", iter_pages)

    sorted_stdout, _ = await sort(dify_accessor, [guide_path],
                                  index=dify_index)
    assert await materialize(sorted_stdout) == b"alpha 1\nalpha 1\nbeta 2\n"

    uniq_stdout, _ = await uniq(dify_accessor, [guide_path], index=dify_index)
    assert await materialize(uniq_stdout) == b"beta 2\nalpha 1\n"
