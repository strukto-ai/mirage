from typing import cast

import pytest

from mirage.accessor.gridfs import GridFSAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.gridfs.stat import stat
from mirage.commands.config import CommandOpts
from mirage.io.types import materialize
from mirage.ops.types import NamespaceView, StatOverlay
from mirage.types import FileStat, FileType, PathSpec

_BACKEND_MTIME = "2020-05-05T05:05:05Z"
_OVERLAY_MTIME = "2024-01-01T00:00:00Z"


def _backend_stat() -> FileStat:
    return FileStat(name="f.txt",
                    size=6,
                    modified=_BACKEND_MTIME,
                    mode=0o644,
                    type=FileType.TEXT)


async def _fake_stat_core(_accessor: GridFSAccessor,
                          _path: PathSpec,
                          index: IndexCacheStore = NULL_INDEX) -> FileStat:
    return _backend_stat()


async def _fake_resolve_glob(_accessor: GridFSAccessor, paths: list[PathSpec],
                             _index: IndexCacheStore) -> list[PathSpec]:
    return paths


def _overlay(_virtual: str, st: FileStat) -> FileStat:
    return st.model_copy(update={"mode": 0o600, "modified": _OVERLAY_MTIME})


@pytest.fixture
def patched_backend(monkeypatch):
    globals_ = stat.__wrapped__.__globals__
    monkeypatch.setitem(globals_, "stat_core", _fake_stat_core)
    monkeypatch.setitem(globals_, "resolve_glob", _fake_resolve_glob)


async def _render(fmt: str,
                  stat_overlay: StatOverlay | None = None) -> tuple[int, str]:
    out, io = await stat(
        cast(GridFSAccessor, object()),
        [PathSpec.from_str_path('/gridfs/f.txt')], [],
        CommandOpts(index=NULL_INDEX,
                    ns=NamespaceView(stat_overlay=stat_overlay),
                    flags={'c': fmt}))
    return io.exit_code, (await materialize(out)).decode()


@pytest.mark.asyncio
async def test_stat_c_applies_namespace_overlay(patched_backend):
    """GridFS registers no setattr op, so chmod/touch state lives only in the
    namespace overlay; the bespoke stat command must merge it in, like the
    generic_bind builder does, or stat -c disagrees with ls -l."""
    code, out = await _render("%a|%y", stat_overlay=_overlay)
    assert code == 0
    assert out == f"600|{_OVERLAY_MTIME}\n"


@pytest.mark.asyncio
async def test_stat_c_without_overlay_reports_backend_values(patched_backend):
    code, out = await _render("%a|%y")
    assert code == 0
    assert out == f"644|{_BACKEND_MTIME}\n"
