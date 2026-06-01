from types import SimpleNamespace

import pytest

from mirage.commands.builtin.ssh.cat import cat
from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.io.types import materialize
from mirage.types import PathSpec

_CONTENT = {"alpha.txt": b"alpha\n", "beta.txt": b"beta\n"}
_GLOBALS = cat.__wrapped__.__globals__


def _p(original: str) -> PathSpec:
    return PathSpec.from_str_path(original, "/ssh/")


async def _resolve_glob(accessor, paths, index):
    return list(paths)


async def _local_stat(accessor, path, index):
    return None


async def _read_bytes(accessor, path, index):
    return _CONTENT[path.strip_prefix]


async def _read_stream(accessor, path, index):
    yield _CONTENT[path.strip_prefix]


@pytest.mark.asyncio
async def test_cat_multifile_caches_materialized_bytes_per_file(monkeypatch):
    monkeypatch.setitem(_GLOBALS, "resolve_glob", _resolve_glob)
    monkeypatch.setitem(_GLOBALS, "local_stat", _local_stat)
    monkeypatch.setitem(_GLOBALS, "read_bytes", _read_bytes)

    accessor = SimpleNamespace(root="/")
    source, io = await cat(
        accessor,
        [_p("/ssh/alpha.txt"), _p("/ssh/beta.txt")], index=None)

    assert io.reads["alpha.txt"] == b"alpha\n"
    assert io.reads["beta.txt"] == b"beta\n"
    assert all(isinstance(v, bytes) for v in io.reads.values())
    assert await materialize(source) == b"alpha\nbeta\n"


@pytest.mark.asyncio
async def test_cat_single_file_keeps_streaming_cachable(monkeypatch):
    monkeypatch.setitem(_GLOBALS, "resolve_glob", _resolve_glob)
    monkeypatch.setitem(_GLOBALS, "local_stat", _local_stat)
    monkeypatch.setitem(_GLOBALS, "read_stream", _read_stream)

    accessor = SimpleNamespace(root="/")
    source, io = await cat(accessor, [_p("/ssh/alpha.txt")], index=None)

    assert isinstance(source, CachableAsyncIterator)
    assert io.reads["alpha.txt"] is source
