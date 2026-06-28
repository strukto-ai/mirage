import pytest

from mirage.commands.builtin.dify.cat import make_cat
from mirage.commands.builtin.generic_bind import CommandIO, with_read_cache
from mirage.core.dify import read, tree
from mirage.core.dify.read import read_bytes as _read_bytes
from mirage.core.dify.read import read_stream as _read_stream
from mirage.core.dify.readdir import readdir as _readdir
from mirage.core.dify.stat import stat as _stat
from mirage.io.types import materialize
from mirage.types import PathSpec

from .conftest import document

cat = make_cat(
    with_read_cache(
        CommandIO(
            readdir=_readdir,
            read_bytes=_read_bytes,
            read_stream=_read_stream,
            stat=_stat,
            is_mounted=lambda a: True,
            local=False,
        )))


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
    assert guide_path.strip_prefix in io.reads
    assert io.cache == [guide_path.strip_prefix]


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

    assert io.reads[guide_path.strip_prefix] == b"alpha\nbeta\ngamma"
    assert io.reads[readme_path.strip_prefix] == b"readme"
    assert all(isinstance(v, bytes) for v in io.reads.values())
    assert await materialize(stdout) == b"alpha\nbeta\ngammareadme"
