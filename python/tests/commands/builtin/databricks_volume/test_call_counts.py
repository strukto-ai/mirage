import time
from functools import partial

import pytest

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import RAMIndexCacheStore
from mirage.commands.builtin.generic.find import parse_find_args, walk_find
from mirage.commands.builtin.generic.ls import ls as generic_ls
from mirage.commands.builtin.generic.tree import tree as generic_tree
from mirage.core.databricks_volume.path import backend_path
from mirage.core.databricks_volume.readdir import readdir
from mirage.core.databricks_volume.stat import stat
from mirage.resource.databricks_volume import DatabricksVolumeConfig
from mirage.types import LsSortBy, PathSpec
from mirage.utils.key_prefix import mount_key
from tests.core.databricks_volume.conftest import (FakeClient, FakeFiles,
                                                   directory_entry, file_entry)

MODIFIED_MS = 1_700_000_000_000


def is_dir_name(_child: str) -> bool | None:
    # Databricks readdir returns slash-less paths, so classification always
    # falls back to stat.
    return None


FROZEN_NOW_S = 1_700_000_000
DAY_S = 86_400
AGES_DAYS = (1, 2, 3, 10, 20)


def _rig(
) -> tuple[DatabricksVolumeAccessor, FakeFiles, RAMIndexCacheStore, str]:
    config = DatabricksVolumeConfig(
        catalog="main",
        schema="default",
        volume="agent_files",
        root_path="/root",
        token="secret",
    )
    files = FakeFiles()
    accessor = DatabricksVolumeAccessor(config, FakeClient(files))
    index = RAMIndexCacheStore(ttl=600)
    return accessor, files, index, backend_path(config, "/")


def _seed_flat(files: FakeFiles, root: str, count: int = 5) -> None:
    files.directories[f"{root}/sub"] = [
        file_entry(f"{root}/sub/f{i}.txt",
                   size=i + 1,
                   modified=MODIFIED_MS + i * 1000) for i in range(count)
    ]


def _ls_readdir(accessor: DatabricksVolumeAccessor):
    return partial(readdir, accessor)


def _ls_stat(accessor: DatabricksVolumeAccessor):
    return partial(stat, accessor)


@pytest.mark.asyncio
@pytest.mark.parametrize("sort_by,long", [
    (LsSortBy.NAME, False),
    (LsSortBy.NAME, True),
    (LsSortBy.TIME, False),
    (LsSortBy.SIZE, False),
])
async def test_ls_lists_once_without_per_entry_metadata(sort_by, long):
    accessor, files, index, root = _rig()
    _seed_flat(files, root, count=5)
    path = PathSpec.from_str_path("/volume/sub",
                                  mount_key("/volume/sub", "/volume"))
    await generic_ls([path],
                     readdir=_ls_readdir(accessor),
                     stat=_ls_stat(accessor),
                     long=long,
                     sort_by=sort_by,
                     index=index)
    assert files.list_directory_calls == [f"{root}/sub"]
    assert files.get_metadata_calls == []
    assert files.get_directory_metadata_calls == []


@pytest.mark.asyncio
async def test_ls_recursive_one_list_per_directory():
    accessor, files, index, root = _rig()
    files.directories[f"{root}/sub"] = [
        file_entry(f"{root}/sub/a.txt", size=1, modified=MODIFIED_MS),
        directory_entry(f"{root}/sub/inner"),
    ]
    files.directories[f"{root}/sub/inner"] = [
        file_entry(f"{root}/sub/inner/b.txt", size=2, modified=MODIFIED_MS),
    ]
    path = PathSpec.from_str_path("/volume/sub",
                                  mount_key("/volume/sub", "/volume"))
    await generic_ls([path],
                     readdir=_ls_readdir(accessor),
                     stat=_ls_stat(accessor),
                     recursive=True,
                     index=index)
    assert sorted(
        files.list_directory_calls) == [f"{root}/sub", f"{root}/sub/inner"]
    assert files.get_metadata_calls == []
    assert files.get_directory_metadata_calls == []


@pytest.mark.asyncio
async def test_tree_one_list_per_directory_without_metadata():
    accessor, files, index, root = _rig()
    files.directories[f"{root}/sub"] = [
        file_entry(f"{root}/sub/a.txt", size=1, modified=MODIFIED_MS),
        directory_entry(f"{root}/sub/inner"),
    ]
    files.directories[f"{root}/sub/inner"] = [
        file_entry(f"{root}/sub/inner/b.txt", size=2, modified=MODIFIED_MS),
    ]
    path = PathSpec.from_str_path("/volume/sub",
                                  mount_key("/volume/sub", "/volume"))
    await generic_tree(path,
                       readdir=_ls_readdir(accessor),
                       stat=_ls_stat(accessor),
                       index=index)
    assert sorted(
        files.list_directory_calls) == [f"{root}/sub", f"{root}/sub/inner"]
    assert files.get_metadata_calls == []
    assert files.get_directory_metadata_calls == []


async def _run_find(accessor, index, *, type=None, size=None, mtime=None):
    args = parse_find_args((), type=type, size=size, mtime=mtime)
    path = PathSpec.from_str_path("/volume/sub",
                                  mount_key("/volume/sub", "/volume"))
    return await walk_find(path,
                           readdir=_ls_readdir(accessor),
                           stat=_ls_stat(accessor),
                           is_dir_name=is_dir_name,
                           index=index,
                           args=args)


@pytest.mark.asyncio
async def test_find_type_does_not_stat_children():
    accessor, files, index, root = _rig()
    _seed_flat(files, root, count=5)
    files.directory_metadata.add(f"{root}/sub")
    results = await _run_find(accessor, index, type="f")
    assert len(results) == 5
    assert files.list_directory_calls == [f"{root}/sub"]
    child_metadata = [c for c in files.get_metadata_calls if "/sub/" in c]
    assert child_metadata == []


@pytest.mark.asyncio
async def test_find_size_reads_size_from_index():
    accessor, files, index, root = _rig()
    _seed_flat(files, root, count=5)
    files.directory_metadata.add(f"{root}/sub")
    results = await _run_find(accessor, index, type="f", size="+3c")
    assert sorted(r.rsplit("/", 1)[-1]
                  for r in results) == ["f2.txt", "f3.txt", "f4.txt"]
    assert files.list_directory_calls == [f"{root}/sub"]
    child_metadata = [c for c in files.get_metadata_calls if "/sub/" in c]
    assert child_metadata == []


@pytest.mark.asyncio
async def test_find_mtime_reads_modified_from_index(monkeypatch):
    monkeypatch.setattr(time, "time", lambda: float(FROZEN_NOW_S))
    accessor, files, index, root = _rig()
    files.directories[f"{root}/sub"] = [
        file_entry(f"{root}/sub/f{i}.txt",
                   size=i + 1,
                   modified=(FROZEN_NOW_S - age * DAY_S) * 1000)
        for i, age in enumerate(AGES_DAYS)
    ]
    files.directory_metadata.add(f"{root}/sub")
    results = await _run_find(accessor, index, mtime="-5")
    assert sorted(r.rsplit("/", 1)[-1]
                  for r in results) == ["f0.txt", "f1.txt", "f2.txt"]
    assert files.list_directory_calls == [f"{root}/sub"]
    child_metadata = [c for c in files.get_metadata_calls if "/sub/" in c]
    assert child_metadata == []
