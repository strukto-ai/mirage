import pytest

from mirage.commands.builtin.dify.grep import grep
from mirage.core.dify import read
from mirage.core.dify import stat as stat_core
from mirage.core.dify import tree
from mirage.io.types import materialize

from .conftest import document


async def list_single_document(config):
    return [document("doc-1", "Guide", "guides/quickstart.md")]


async def iter_basic_pages(config, document_id):
    yield [{"content": "alpha\nbeta"}]
    yield [{"content": "gamma"}]


async def iter_alpha_pages(config, document_id):
    yield [{"content": "alpha beta"}]
    yield [{"content": "gamma alpha"}]


async def get_alpha_segments(config, document_id):
    return [{"content": "alpha beta"}, {"content": "gamma alpha"}]


async def get_detail(config, document_id):
    return {"id": document_id, "updated_at": 1716285600}


async def get_segments_should_not_be_used(config, document_id):
    raise AssertionError("read_bytes should not be used")


@pytest.mark.asyncio
async def test_grep_matches_streamed_segments(monkeypatch, dify_accessor,
                                              dify_index, guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_single_document)
    monkeypatch.setattr(stat_core, "get_document_detail", get_detail)
    monkeypatch.setattr(read, "iter_segment_pages", iter_basic_pages)

    stdout, io = await grep(dify_accessor, [guide_path],
                            "gamma",
                            index=dify_index)

    assert await materialize(stdout) == b"gamma\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_grep_uses_read_stream(monkeypatch, dify_accessor, dify_index,
                                     guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_single_document)
    monkeypatch.setattr(stat_core, "get_document_detail", get_detail)
    monkeypatch.setattr(read, "get_document_segments",
                        get_segments_should_not_be_used)
    monkeypatch.setattr(read, "iter_segment_pages", iter_basic_pages)

    stdout, io = await grep(dify_accessor, [guide_path],
                            "gamma",
                            index=dify_index)

    assert await materialize(stdout) == b"gamma\n"
    assert guide_path.original not in io.reads


@pytest.mark.asyncio
async def test_grep_supports_standard_flags(monkeypatch, dify_accessor,
                                            dify_index, guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_single_document)
    monkeypatch.setattr(stat_core, "get_document_detail", get_detail)
    monkeypatch.setattr(read, "iter_segment_pages", iter_alpha_pages)
    monkeypatch.setattr(read, "get_document_segments", get_alpha_segments)

    plain_stdout, plain_io = await grep(dify_accessor, [guide_path],
                                        "alpha",
                                        index=dify_index)
    assert await materialize(plain_stdout) == b"alpha beta\ngamma alpha\n"
    assert plain_io.exit_code == 0

    numbered_stdout, _ = await grep(dify_accessor, [guide_path],
                                    "alpha",
                                    n=True,
                                    index=dify_index)
    assert await materialize(numbered_stdout
                             ) == b"1:alpha beta\n2:gamma alpha\n"

    count_stdout, _ = await grep(dify_accessor, [guide_path],
                                 "alpha",
                                 c=True,
                                 index=dify_index)
    assert await materialize(count_stdout) == b"2\n"

    files_stdout, _ = await grep(dify_accessor, [guide_path],
                                 "alpha",
                                 args_l=True,
                                 index=dify_index)
    assert await materialize(files_stdout
                             ) == guide_path.original.encode() + b"\n"

    fixed_stdout, _ = await grep(dify_accessor, [guide_path],
                                 "alpha beta",
                                 F=True,
                                 index=dify_index)
    assert await materialize(fixed_stdout) == b"alpha beta\n"

    word_stdout, _ = await grep(dify_accessor, [guide_path],
                                "alph",
                                w=True,
                                index=dify_index)
    assert await materialize(word_stdout) == b""

    quiet_stdout, quiet_io = await grep(dify_accessor, [guide_path],
                                        "alpha",
                                        q=True,
                                        index=dify_index)
    assert quiet_stdout is not None
    assert await materialize(quiet_stdout) == b""
    assert quiet_io.exit_code == 0
