import time

import pytest

from mirage.core.databricks_volume.path import backend_path
from mirage.types import MountMode, PathSpec
from mirage.vfs.databricks_volume import (
    DatabricksVolumeConfig,
    DatabricksVolumeVFS,
)
from mirage.workspace import Workspace
from tests.core.databricks_volume.conftest import (
    FakeClient,
    FakeFiles,
    directory_entry,
    file_entry,
)

MODIFIED_MS = 1_700_000_000_000

FROZEN_NOW_S = 1_700_000_000
DAY_S = 86_400
AGES_DAYS = (1, 2, 3, 10, 20)


def _rig() -> tuple[Workspace, FakeFiles, str]:
    config = DatabricksVolumeConfig(
        catalog="main",
        schema="default",
        volume="agent_files",
        root_path="/root",
        token="secret",
    )
    files = FakeFiles()
    vfs = DatabricksVolumeVFS(config, FakeClient(files))
    root = backend_path(config, PathSpec.from_str_path("/"))
    files.directories[root] = [directory_entry(f"{root}/sub")]
    files.directory_metadata.add(f"{root}/sub")
    return Workspace({"/volume": vfs}, mode=MountMode.READ), files, root


def _seed_flat(files: FakeFiles, root: str, count: int = 5) -> None:
    files.directories[f"{root}/sub"] = [
        file_entry(
            f"{root}/sub/f{i}.txt", size=i + 1, modified=MODIFIED_MS + i * 1000
        )
        for i in range(count)
    ]


def _seed_nested(files: FakeFiles, root: str) -> None:
    files.directories[f"{root}/sub"] = [
        file_entry(f"{root}/sub/a.txt", size=1, modified=MODIFIED_MS),
        directory_entry(f"{root}/sub/inner"),
    ]
    files.directories[f"{root}/sub/inner"] = [
        file_entry(f"{root}/sub/inner/b.txt", size=2, modified=MODIFIED_MS),
    ]


async def _run(ws: Workspace, line: str) -> list[str]:
    try:
        result = await ws.shell(line)
        out = await result.materialize_stdout()
        assert (result.exit_code, await result.stderr_str()) == (0, ""), line
        return out.decode().splitlines()
    finally:
        await ws.close()


def _child_metadata(files: FakeFiles) -> list[str]:
    return [
        call
        for call in files.get_metadata_calls
        + files.get_directory_metadata_calls
        if "/sub/" in call
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("flags", ["", "-l", "-t", "-S"])
async def test_ls_lists_once_without_per_entry_metadata(flags):
    ws, files, root = _rig()
    _seed_flat(files, root, count=5)
    await _run(ws, f"ls {flags} /volume/sub")
    assert files.list_directory_calls.count(f"{root}/sub") == 1
    assert _child_metadata(files) == []


@pytest.mark.asyncio
async def test_ls_recursive_one_list_per_directory():
    ws, files, root = _rig()
    _seed_nested(files, root)
    await _run(ws, "ls -R /volume/sub")
    assert sorted(set(files.list_directory_calls) - {root}) == [
        f"{root}/sub",
        f"{root}/sub/inner",
    ]
    assert len(files.list_directory_calls) == len(
        set(files.list_directory_calls)
    )
    assert _child_metadata(files) == []


@pytest.mark.asyncio
async def test_tree_one_list_per_directory_without_metadata():
    ws, files, root = _rig()
    _seed_nested(files, root)
    await _run(ws, "tree /volume/sub")
    assert sorted(set(files.list_directory_calls) - {root}) == [
        f"{root}/sub",
        f"{root}/sub/inner",
    ]
    assert len(files.list_directory_calls) == len(
        set(files.list_directory_calls)
    )
    assert _child_metadata(files) == []


@pytest.mark.asyncio
async def test_find_type_does_not_stat_children():
    ws, files, root = _rig()
    _seed_flat(files, root, count=5)
    results = await _run(ws, "find /volume/sub -type f")
    assert len(results) == 5
    assert files.list_directory_calls.count(f"{root}/sub") == 1
    assert _child_metadata(files) == []


@pytest.mark.asyncio
async def test_find_size_reads_size_from_the_listing():
    ws, files, root = _rig()
    _seed_flat(files, root, count=5)
    results = await _run(ws, "find /volume/sub -type f -size +3c")
    assert sorted(r.rsplit("/", 1)[-1] for r in results) == [
        "f3.txt",
        "f4.txt",
    ]
    assert files.list_directory_calls.count(f"{root}/sub") == 1
    assert _child_metadata(files) == []


@pytest.mark.asyncio
async def test_find_mtime_reads_modified_from_the_listing(monkeypatch):
    monkeypatch.setattr(time, "time", lambda: float(FROZEN_NOW_S))
    ws, files, root = _rig()
    files.directories[f"{root}/sub"] = [
        file_entry(
            f"{root}/sub/f{i}.txt",
            size=i + 1,
            modified=(FROZEN_NOW_S - age * DAY_S) * 1000,
        )
        for i, age in enumerate(AGES_DAYS)
    ]
    results = await _run(ws, "find /volume/sub -mtime -5")
    assert sorted(r.rsplit("/", 1)[-1] for r in results if "/f" in r) == [
        "f0.txt",
        "f1.txt",
        "f2.txt",
    ]
    assert files.list_directory_calls.count(f"{root}/sub") == 1
    assert _child_metadata(files) == []
