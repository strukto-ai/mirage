import pytest

from mirage.core.dify import grep, read, tree

from .conftest import list_basic_documents


async def iter_pages(config, document_id):
    yield [{"content": "Alpha"}]
    yield [{"content": "beta"}]


@pytest.mark.asyncio
async def test_grep_bytes_matches_streamed_lines_and_records_reads(
        monkeypatch, dify_accessor, dify_index, guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_basic_documents)
    monkeypatch.setattr(read, "iter_segment_pages", iter_pages)

    output, reads = await grep.grep_bytes(dify_accessor, [guide_path],
                                          "alpha",
                                          dify_index,
                                          ignore_case=True)

    assert output == b"/knowledge/guides/quickstart:1:Alpha"
    assert reads == {guide_path.virtual: b"Alpha\nbeta"}
