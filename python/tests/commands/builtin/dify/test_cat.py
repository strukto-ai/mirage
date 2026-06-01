import pytest

from mirage.commands.builtin.dify.cat import cat
from mirage.core.dify import read, tree
from mirage.io.types import materialize
from mirage.types import PathSpec

from .conftest import document


async def list_basic_documents(config):
    return [
        document("doc-1", "Guide", "guides/quickstart.md"),
        document("doc-2", "Readme", "README.md"),
    ]


async def iter_basic_pages(config, document_id):
    if document_id == "doc-1":
        yield [{"content": "alpha\nbeta"}, {"content": "gamma"}]
    else:
        yield [{"content": "readme"}]


@pytest.mark.asyncio
async def test_cat_reads_stream_and_records_cache(monkeypatch, dify_accessor,
                                                  dify_index, guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_basic_documents)
    monkeypatch.setattr(read, "iter_segment_pages", iter_basic_pages)

    stdout, io = await cat(dify_accessor, [guide_path], index=dify_index)

    assert await materialize(stdout) == b"alpha\nbeta\ngamma"
    assert guide_path.original in io.reads
    assert io.cache == [guide_path.original]


async def get_two_doc_segments(config, document_id):
    if document_id == "doc-1":
        return [{"content": "alpha\nbeta"}, {"content": "gamma"}]
    return [{"content": "readme"}]


@pytest.mark.asyncio
async def test_cat_multifile_caches_materialized_bytes_per_file(
        monkeypatch, dify_accessor, dify_index, guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_basic_documents)
    monkeypatch.setattr(read, "get_document_segments", get_two_doc_segments)

    readme_path = PathSpec.from_str_path("/knowledge/README.md", "/knowledge/")
    stdout, io = await cat(dify_accessor, [guide_path, readme_path],
                           index=dify_index)

    assert io.reads[guide_path.original] == b"alpha\nbeta\ngamma"
    assert io.reads[readme_path.original] == b"readme"
    assert all(isinstance(v, bytes) for v in io.reads.values())
    assert await materialize(stdout) == b"alpha\nbeta\ngammareadme"
