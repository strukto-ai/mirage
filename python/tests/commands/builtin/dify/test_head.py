import pytest

from mirage.commands.builtin.dify.head import head
from mirage.core.dify import read, tree
from mirage.io.types import materialize

from .conftest import document


async def list_single_document(config):
    return [document("doc-1", "Guide", "guides/quickstart.md")]


async def iter_basic_pages(config, document_id):
    yield [{"content": "alpha\nbeta"}]
    yield [{"content": "gamma"}]


async def iter_bytes_pages(config, document_id):
    yield [{"content": "abcdef"}]


async def get_segments_should_not_be_used(config, document_id):
    raise AssertionError("read_bytes should not be used")


@pytest.mark.asyncio
async def test_head_reads_first_lines_from_stream(monkeypatch, dify_accessor,
                                                  dify_index, guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_single_document)
    monkeypatch.setattr(read, "iter_segment_pages", iter_basic_pages)

    stdout, _ = await head(dify_accessor, [guide_path], index=dify_index, n=2)

    assert await materialize(stdout) == b"alpha\nbeta\n"


@pytest.mark.asyncio
async def test_head_uses_read_stream(monkeypatch, dify_accessor, dify_index,
                                     guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_single_document)
    monkeypatch.setattr(read, "get_document_segments",
                        get_segments_should_not_be_used)
    monkeypatch.setattr(read, "iter_segment_pages", iter_basic_pages)

    stdout, _ = await head(dify_accessor, [guide_path], index=dify_index, n=2)

    assert await materialize(stdout) == b"alpha\nbeta\n"


@pytest.mark.asyncio
async def test_head_supports_byte_counts(monkeypatch, dify_accessor,
                                         dify_index, guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_single_document)
    monkeypatch.setattr(read, "iter_segment_pages", iter_bytes_pages)

    stdout, _ = await head(dify_accessor, [guide_path],
                           c="3",
                           index=dify_index)

    assert await materialize(stdout) == b"abc"
