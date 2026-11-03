# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import asyncio
import errno
import os
import shutil
import threading
from pathlib import Path

import pytest

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.copy import copy
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec


@pytest.fixture
def accessor(tmp_path):
    root = tmp_path.resolve()
    (root / "src").write_text("X")
    return DiskAccessor(root)


@pytest.mark.asyncio
async def test_copy_duplicates_a_file(accessor):
    await copy(
        accessor,
        PathSpec.from_str_path("/src"),
        PathSpec.from_str_path("/dst"),
    )
    assert (accessor.root / "dst").read_text() == "X"


@pytest.mark.asyncio
async def test_copy_does_not_create_the_destination_parent(accessor):
    with pytest.raises(FileNotFoundError):
        await copy(
            accessor,
            PathSpec.from_str_path("/src"),
            PathSpec.from_str_path("/a/b/dst"),
        )
    assert not (accessor.root / "a").exists()


@pytest.mark.asyncio
async def test_copy_that_wrote_nothing_records_a_failed_row(accessor):
    scope = RecordingScope()
    try:
        with pytest.raises(FileNotFoundError):
            await copy(
                accessor,
                PathSpec.from_str_path("/src"),
                PathSpec.from_str_path("/a/b/dst"),
            )
    finally:
        scope.close()
    [row] = scope.records
    assert (row.status, row.changed, row.errno) == (
        "failed",
        False,
        errno.ENOENT,
    )


@pytest.mark.asyncio
async def test_copy_blames_the_destination_when_its_parent_is_missing(
    accessor,
):
    # copy2 answers ENOENT for a missing source too, so the failure has to be
    # attributed to the destination rather than assumed to be the source.
    with pytest.raises(FileNotFoundError) as excinfo:
        await copy(
            accessor,
            PathSpec.from_str_path("/src"),
            PathSpec.from_str_path("/a/b/dst"),
        )
    assert excinfo.value.filename == "/a/b/dst"


@pytest.mark.asyncio
async def test_copy_blames_the_source_when_it_is_the_missing_operand(accessor):
    with pytest.raises(FileNotFoundError) as excinfo:
        await copy(
            accessor,
            PathSpec.from_str_path("/nope"),
            PathSpec.from_str_path("/dst"),
        )
    assert excinfo.value.filename == "/nope"


@pytest.mark.skipif(
    os.geteuid() == 0, reason="root ignores the permission bits under test"
)
@pytest.mark.asyncio
async def test_copy_blames_the_source_when_it_is_unreadable(accessor):
    (accessor.root / "src").chmod(0)
    try:
        with pytest.raises(PermissionError) as excinfo:
            await copy(
                accessor,
                PathSpec.from_str_path("/src"),
                PathSpec.from_str_path("/dst"),
            )
    finally:
        (accessor.root / "src").chmod(0o644)
    assert excinfo.value.filename == "/src"


@pytest.mark.skipif(
    os.geteuid() == 0, reason="root ignores the permission bits under test"
)
@pytest.mark.asyncio
async def test_copy_blames_the_destination_when_it_is_unwritable(accessor):
    (accessor.root / "ro").mkdir()
    (accessor.root / "ro").chmod(0o555)
    try:
        with pytest.raises(PermissionError) as excinfo:
            await copy(
                accessor,
                PathSpec.from_str_path("/src"),
                PathSpec.from_str_path("/ro/dst"),
            )
    finally:
        (accessor.root / "ro").chmod(0o755)
    assert excinfo.value.filename == "/ro/dst"


@pytest.mark.asyncio
async def test_copy_never_leaks_the_host_path(accessor):
    for src, dst in (("/src", "/a/b/dst"), ("/nope", "/dst")):
        with pytest.raises(OSError) as excinfo:
            await copy(
                accessor,
                PathSpec.from_str_path(src),
                PathSpec.from_str_path(dst),
            )
        assert str(accessor.root) not in str(excinfo.value)


@pytest.mark.asyncio
async def test_copy_records_partial_after_bytes_were_written(
    accessor, monkeypatch
):
    (accessor.root / "src").write_bytes(b"content")

    def fail_metadata(src, dst):
        raise OSError(errno.EACCES, "denied")

    monkeypatch.setattr(shutil, "copystat", fail_metadata)
    scope = RecordingScope()
    try:
        with pytest.raises(OSError):
            await copy(
                accessor,
                PathSpec.from_str_path("/src"),
                PathSpec.from_str_path("/dst"),
            )
    finally:
        scope.close()
    assert (accessor.root / "dst").read_bytes() == b"content"
    assert len(scope.records) == 1
    row = scope.records[0]
    assert (row.status, row.changed, row.errno) == (
        "partial",
        True,
        errno.EACCES,
    )


@pytest.mark.asyncio
async def test_a_cancelled_copy_records_partial_without_probing(
    accessor, monkeypatch
):
    (accessor.root / "src").write_bytes(b"content")
    entered, release = threading.Event(), threading.Event()

    def stalled(src, dst):
        entered.set()
        release.wait()

    monkeypatch.setattr(shutil, "copyfile", stalled)
    scope = RecordingScope()
    try:
        task = asyncio.create_task(
            copy(
                accessor,
                PathSpec.from_str_path("/src"),
                PathSpec.from_str_path("/dst"),
            )
        )
        await asyncio.to_thread(entered.wait)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        release.set()
        scope.close()
    [row] = scope.records
    assert (row.status, row.changed) == ("partial", True)


def _unprobeable(monkeypatch, path: Path) -> None:
    real = os.stat

    def stat(target, *args, **kwargs):
        if Path(target) == path:
            raise OSError(errno.EIO, "probe")
        return real(target, *args, **kwargs)

    monkeypatch.setattr(os, "stat", stat)


def _fills_then_fails(src, dst):
    Path(dst).write_bytes(b"half")
    raise OSError(errno.ENOSPC, "No space left on device")


@pytest.mark.asyncio
async def test_a_copy_neither_probe_could_see_records_partial(
    accessor, monkeypatch
):
    dst = accessor.root / "dst"
    _unprobeable(monkeypatch, dst)
    monkeypatch.setattr(shutil, "copyfile", _fills_then_fails)
    scope = RecordingScope()
    try:
        with pytest.raises(OSError):
            await copy(
                accessor,
                PathSpec.from_str_path("/src"),
                PathSpec.from_str_path("/dst"),
            )
    finally:
        scope.close()
    assert dst.read_bytes() == b"half"
    [row] = scope.records
    assert (row.status, row.changed, row.errno) == ("partial", True, 28)


@pytest.mark.asyncio
async def test_a_copy_cancelled_while_probing_still_records_its_row(
    accessor, monkeypatch
):
    dst = accessor.root / "dst"
    entered, release = threading.Event(), threading.Event()
    real = os.stat
    calls = 0

    def stat(target, *args, **kwargs):
        nonlocal calls
        if Path(target) == dst:
            calls += 1
            if calls == 2:
                entered.set()
                release.wait()
        return real(target, *args, **kwargs)

    monkeypatch.setattr(os, "stat", stat)
    monkeypatch.setattr(shutil, "copyfile", _fills_then_fails)
    scope = RecordingScope()
    try:
        task = asyncio.create_task(
            copy(
                accessor,
                PathSpec.from_str_path("/src"),
                PathSpec.from_str_path("/dst"),
            )
        )
        await asyncio.to_thread(entered.wait)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        release.set()
        scope.close()
    [row] = scope.records
    assert (row.status, row.changed, row.errno) == ("partial", True, 28)
