import importlib
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from mirage.commands.builtin.generic.search import search_resources
from mirage.types import PathSpec
from mirage.vfs.chroma import ChromaVFS
from mirage.vfs.dify import DifyVFS
from mirage.vfs.lancedb import LanceDBVFS
from mirage.vfs.mem0 import Mem0VFS
from mirage.vfs.qdrant import QdrantVFS
from mirage.vfs.search import int_option
from mirage.vfs.types import SearchQuery
from tests.fixtures.vfs_io import vfs_over

PATH = PathSpec(virtual="/data", directory="/", vfs_path="")


@pytest.mark.parametrize("value", [True, "10", None, 1.5])
def test_search_options_reject_non_integer_limits(value):
    with pytest.raises(ValueError, match="integer"):
        int_option(SearchQuery("query", options={"top_k": value}), "top_k", 10)


VFS_CLASSES = {
    "chroma": ChromaVFS,
    "dify": DifyVFS,
    "qdrant": QdrantVFS,
    "lancedb": LanceDBVFS,
    "mem0": Mem0VFS,
}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "backend,core,operation",
    [
        ("chroma", "chroma", "search_segments"),
        ("dify", "dify", "search_segments"),
        ("qdrant", "vector", "search_rows_output"),
        ("lancedb", "vector", "search_rows_output"),
        ("mem0", "mem0", "search_memories_rendered"),
    ],
)
async def test_builtin_semantic_adapters_delegate_one_batch(
    monkeypatch, backend, core, operation
):
    module = importlib.import_module(f"mirage.core.{core}.search")
    raw = AsyncMock(return_value=[("/data/a", "ranked record")])
    monkeypatch.setattr(module, operation, raw)
    options = {"top_k": 2}
    if backend != "chroma":
        options.update({"method": "semantic", "threshold": 0.5})
    client = SimpleNamespace(
        config=SimpleNamespace(search_limit=10, default_search_limit=10)
    )
    vfs = vfs_over(VFS_CLASSES[backend], client)

    async def dispatch(name, path, /, query, scopes):
        return await vfs.search_many([path, *scopes], query), None

    result = await search_resources(
        dispatch, [PATH, PATH], SearchQuery("question", options=options)
    )
    assert result == b"ranked record\n"
    raw.assert_awaited_once()
    assert raw.await_args.kwargs["top_k"] == 2
    assert raw.await_args.kwargs["mount_prefix"] == "/data"
