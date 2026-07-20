import asyncio

import pytest

from mirage.core.dify import grep, read, tree
from mirage.types import PathSpec

from .conftest import list_basic_documents


async def iter_pages(config, document_id):
    yield [{"content": "Alpha"}]
    yield [{"content": "beta"}]


class ConcurrentReadStream:

    def __init__(self) -> None:
        self.active = 0
        self.max_active = 0

    async def __call__(self, accessor, path, index):
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        await asyncio.sleep(0)
        yield f"{path.virtual} match\n".encode()
        self.active -= 1


@pytest.mark.asyncio
async def test_grep_bytes_matches_streamed_lines(monkeypatch, dify_accessor,
                                                 dify_index, guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_basic_documents)
    monkeypatch.setattr(read, "iter_segment_pages", iter_pages)

    output = await grep.grep_bytes(dify_accessor, [guide_path],
                                   "alpha",
                                   dify_index,
                                   ignore_case=True)

    assert output == b"/knowledge/guides/quickstart:1:Alpha"


@pytest.mark.asyncio
async def test_grep_bytes_bounds_workers_and_preserves_order(
        monkeypatch, dify_accessor, dify_index):
    dify_accessor.config.max_concurrency = 3
    paths = [
        PathSpec.from_str_path(f"/knowledge/{position}", str(position))
        for position in range(12)
    ]
    read_stream = ConcurrentReadStream()
    monkeypatch.setattr(grep, "read_stream", read_stream)

    output = await grep.grep_bytes(dify_accessor, paths, "match", dify_index)

    assert output.decode().splitlines() == [
        f"{path.virtual}:1:{path.virtual} match" for path in paths
    ]
    assert read_stream.max_active == dify_accessor.config.max_concurrency
