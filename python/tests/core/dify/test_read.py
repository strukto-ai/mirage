import pytest

from mirage.core.dify import read, tree

from .conftest import list_basic_documents


async def get_segments(config, document_id):
    return [{"content": "first"}, {"content": "second"}]


async def iter_pages(config, document_id):
    yield [{"content": "first"}]
    yield [{"content": "second"}]


@pytest.mark.asyncio
async def test_read_bytes_uses_document_segments(monkeypatch, dify_accessor,
                                                 dify_index, guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_basic_documents)
    monkeypatch.setattr(read, "get_document_segments", get_segments)

    data = await read.read_bytes(dify_accessor, guide_path, dify_index)

    assert data == b"first\nsecond"


@pytest.mark.asyncio
async def test_read_stream_separates_pages_with_single_newline(
        monkeypatch, dify_accessor, dify_index, guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_basic_documents)
    monkeypatch.setattr(read, "iter_segment_pages", iter_pages)

    chunks = [
        chunk async for chunk in read.read_stream(dify_accessor, guide_path,
                                                  dify_index)
    ]

    assert chunks == [b"first", b"\n", b"second"]


@pytest.mark.asyncio
async def test_read_bytes_rejects_directories(monkeypatch, dify_accessor,
                                              dify_index, knowledge_root):
    monkeypatch.setattr(tree, "list_all_documents", list_basic_documents)

    with pytest.raises(IsADirectoryError):
        await read.read_bytes(dify_accessor, knowledge_root, dify_index)
