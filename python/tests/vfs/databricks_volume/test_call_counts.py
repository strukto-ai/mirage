import time

import pytest

from mirage.types import MountMode
from mirage.vfs.databricks_volume import DatabricksVolumeVFS
from mirage.workspace import Workspace
from tests.fixtures.databricks_volume import (
    DIRS,
    FILES,
    ROOT,
    DatabricksVolume,
)

FROZEN_NOW_S = 1_700_000_000
DAY_S = 86_400
AGES_DAYS = (1, 2, 3, 10, 20)


def _rig(volume: DatabricksVolume) -> Workspace:
    return Workspace(
        {"/volume": DatabricksVolumeVFS(volume.config())}, mode=MountMode.READ
    )


async def _seed_flat(volume: DatabricksVolume, count: int = 5) -> None:
    for i in range(count):
        await volume.put(f"{ROOT}/sub/f{i}.txt", b"x" * (i + 1))


async def _seed_nested(volume: DatabricksVolume) -> None:
    await volume.put(f"{ROOT}/sub/a.txt", b"a")
    await volume.put(f"{ROOT}/sub/inner/b.txt", b"bb")


async def _run(ws: Workspace, line: str) -> list[str]:
    try:
        result = await ws.shell(line)
        out = await result.materialize_stdout()
        assert (result.exit_code, await result.stderr_str()) == (0, ""), line
        return out.decode().splitlines()
    finally:
        await ws.close()


async def _listings(volume: DatabricksVolume) -> list[str]:
    return await volume.asked("GET", DIRS)


async def _child_metadata(volume: DatabricksVolume) -> list[str]:
    asked = await volume.asked("HEAD", FILES) + await volume.asked(
        "HEAD", DIRS
    )
    return [call for call in asked if "/sub/" in call]


@pytest.mark.asyncio
@pytest.mark.parametrize("flags", ["", "-l", "-t", "-S"])
async def test_ls_lists_once_without_per_entry_metadata(volume, flags):
    await _seed_flat(volume, count=5)
    ws = _rig(volume)
    await volume.run.record_requests()
    await _run(ws, f"ls {flags} /volume/sub")
    assert (await _listings(volume)).count(f"{ROOT}/sub") == 1
    assert await _child_metadata(volume) == []


@pytest.mark.asyncio
async def test_ls_recursive_one_list_per_directory(volume):
    await _seed_nested(volume)
    ws = _rig(volume)
    await volume.run.record_requests()
    await _run(ws, "ls -R /volume/sub")
    listings = await _listings(volume)
    assert sorted(set(listings) - {ROOT}) == [
        f"{ROOT}/sub",
        f"{ROOT}/sub/inner",
    ]
    assert len(listings) == len(set(listings))
    assert await _child_metadata(volume) == []


@pytest.mark.asyncio
async def test_tree_one_list_per_directory_without_metadata(volume):
    await _seed_nested(volume)
    ws = _rig(volume)
    await volume.run.record_requests()
    await _run(ws, "tree /volume/sub")
    listings = await _listings(volume)
    assert sorted(set(listings) - {ROOT}) == [
        f"{ROOT}/sub",
        f"{ROOT}/sub/inner",
    ]
    assert len(listings) == len(set(listings))
    assert await _child_metadata(volume) == []


@pytest.mark.asyncio
async def test_find_type_does_not_stat_children(volume):
    await _seed_flat(volume, count=5)
    ws = _rig(volume)
    await volume.run.record_requests()
    results = await _run(ws, "find /volume/sub -type f")
    assert len(results) == 5
    assert (await _listings(volume)).count(f"{ROOT}/sub") == 1
    assert await _child_metadata(volume) == []


@pytest.mark.asyncio
async def test_find_size_reads_size_from_the_listing(volume):
    await _seed_flat(volume, count=5)
    ws = _rig(volume)
    await volume.run.record_requests()
    results = await _run(ws, "find /volume/sub -type f -size +3c")
    assert sorted(r.rsplit("/", 1)[-1] for r in results) == [
        "f3.txt",
        "f4.txt",
    ]
    assert (await _listings(volume)).count(f"{ROOT}/sub") == 1
    assert await _child_metadata(volume) == []


@pytest.mark.asyncio
async def test_find_mtime_reads_modified_from_the_listing(volume, monkeypatch):
    for i, age in enumerate(AGES_DAYS):
        await volume.put(f"{ROOT}/sub/f{i}.txt", b"x" * (i + 1))
        await volume.set_modified(
            f"{ROOT}/sub/f{i}.txt", (FROZEN_NOW_S - age * DAY_S) * 1000
        )
    monkeypatch.setattr(time, "time", lambda: float(FROZEN_NOW_S))
    ws = _rig(volume)
    await volume.run.record_requests()
    results = await _run(ws, "find /volume/sub -mtime -5")
    assert sorted(r.rsplit("/", 1)[-1] for r in results if "/f" in r) == [
        "f0.txt",
        "f1.txt",
        "f2.txt",
    ]
    assert (await _listings(volume)).count(f"{ROOT}/sub") == 1
    assert await _child_metadata(volume) == []
