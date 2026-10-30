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

import pytest

import mirage.core.disk.write as disk_write
from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.constants import STREAM_BATCH_BYTES, STREAM_FLUSH_SECONDS
from mirage.core.disk.write import write
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_write_new_file(tmp_path):
    accessor = DiskAccessor(tmp_path)
    await write(
        accessor,
        PathSpec(vfs_path="new.txt", virtual="/new.txt", directory="/new.txt"),
        b"content",
    )
    assert (tmp_path / "new.txt").read_bytes() == b"content"


@pytest.mark.asyncio
async def test_overwrite_existing_file(tmp_path):
    (tmp_path / "exist.txt").write_bytes(b"old")
    accessor = DiskAccessor(tmp_path)
    await write(
        accessor,
        PathSpec(
            vfs_path="exist.txt", virtual="/exist.txt", directory="/exist.txt"
        ),
        b"new",
    )
    assert (tmp_path / "exist.txt").read_bytes() == b"new"


@pytest.mark.asyncio
async def test_write_does_not_create_parents(tmp_path):
    # A write is not `mkdir -p`: GNU `echo x > a/b/c/file.txt` fails with
    # ENOENT rather than building the chain, and the store-backed backends
    # refuse the same way.
    accessor = DiskAccessor(tmp_path)
    with pytest.raises(FileNotFoundError):
        await write(
            accessor,
            PathSpec(
                vfs_path="a/b/c/file.txt",
                virtual="/a/b/c/file.txt",
                directory="/a/b/c/file.txt",
            ),
            b"deep",
        )
    assert not (tmp_path / "a").exists()


@pytest.mark.asyncio
async def test_write_into_an_existing_dir(tmp_path):
    (tmp_path / "d").mkdir()
    accessor = DiskAccessor(tmp_path)
    await write(
        accessor,
        PathSpec(
            vfs_path="d/file.txt",
            virtual="/d/file.txt",
            directory="/d/file.txt",
        ),
        b"deep",
    )
    assert (tmp_path / "d" / "file.txt").read_bytes() == b"deep"


@pytest.mark.asyncio
async def test_write_under_a_plain_file_is_not_a_directory(tmp_path):
    (tmp_path / "plain").write_bytes(b"x")
    accessor = DiskAccessor(tmp_path)
    with pytest.raises(NotADirectoryError):
        await write(
            accessor,
            PathSpec(
                vfs_path="plain/file.txt",
                virtual="/plain/file.txt",
                directory="/plain/file.txt",
            ),
            b"data",
        )


@pytest.mark.asyncio
async def test_write_error_reports_the_virtual_path(tmp_path):
    # The host root is an implementation detail of the mount: only the
    # virtual path may reach a user-facing stderr line.
    accessor = DiskAccessor(tmp_path)
    with pytest.raises(FileNotFoundError) as excinfo:
        await write(
            accessor,
            PathSpec(
                vfs_path="nodir/file.txt",
                virtual="/data/nodir/file.txt",
                directory="/data/nodir/file.txt",
            ),
            b"data",
        )
    assert str(tmp_path) not in str(excinfo.value)
    assert "/data/nodir/file.txt" in str(excinfo.value)


@pytest.mark.asyncio
async def test_never_writes_through_a_host_symlink_out_of_the_root(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    target = tmp_path / "target.txt"
    target.write_bytes(b"original")
    (root / "link").symlink_to(target)
    accessor = DiskAccessor(root)
    with pytest.raises(FileNotFoundError):
        await write(
            accessor,
            PathSpec(vfs_path="link", virtual="/link", directory="/link"),
            b"pwned",
        )
    assert target.read_bytes() == b"original"


@pytest.mark.asyncio
@pytest.mark.parametrize("atomic", [False, True])
async def test_stream_failure_closes_source_and_preserves_staged_target(
    tmp_path, atomic
):
    from_path = tmp_path / "file"
    from_path.write_bytes(b"original")
    closed = []

    async def source():
        try:
            yield b"partial"
            raise OSError("read failed")
        finally:
            closed.append(True)

    with pytest.raises(OSError, match="read failed"):
        await write(
            DiskAccessor(tmp_path),
            PathSpec.from_str_path("/file", vfs_path="file"),
            source(),
            atomic=atomic,
        )
    assert closed == [True]
    assert from_path.read_bytes() == (b"original" if atomic else b"partial")
    assert sorted(p.name for p in tmp_path.iterdir()) == ["file"]


@pytest.mark.asyncio
async def test_stream_append_and_atomic_mode(tmp_path):
    target = tmp_path / "file"
    target.write_bytes(b"old")
    target.chmod(0o640)
    accessor = DiskAccessor(tmp_path)
    path = PathSpec.from_str_path("/file", vfs_path="file")

    async def source():
        yield target.read_bytes()
        yield b"new"

    await write(accessor, path, source(), atomic=True)
    assert target.read_bytes() == b"oldnew"
    assert target.stat().st_mode & 0o777 == 0o640
    await write(accessor, path, b"!", append=True)
    assert target.read_bytes() == b"oldnew!"


# Bytes under ``atomic`` are staged and renamed over the file, as a stream
# is, so no reader sees it half written: a link to the old file keeps the
# old bytes, and the file keeps its mode.
@pytest.mark.asyncio
async def test_an_atomic_write_of_bytes_replaces_the_file_whole(tmp_path):
    target = tmp_path / "file"
    target.write_bytes(b"old")
    target.chmod(0o640)
    os.link(target, tmp_path / "held")
    await write(
        DiskAccessor(tmp_path),
        PathSpec.from_str_path("/file", vfs_path="file"),
        b"new",
        atomic=True,
    )
    assert target.read_bytes() == b"new"
    assert (tmp_path / "held").read_bytes() == b"old"
    assert target.stat().st_mode & 0o777 == 0o640


async def _lettered_pieces():
    for i in range(64):
        yield bytes([65 + i % 26]) * (16 * 1024)


@pytest.mark.asyncio
async def test_a_stream_reaches_the_file_in_batches(tmp_path, monkeypatch):
    opened = disk_write.aiofiles.open
    writes = []

    async def counting(*args, **kwargs):
        f = await opened(*args, **kwargs)
        original = f.write

        async def write_one(data):
            writes.append(len(data))
            return await original(data)

        f.write = write_one
        return f

    monkeypatch.setattr(disk_write.aiofiles, "open", counting)
    await write(
        DiskAccessor(tmp_path),
        PathSpec.from_str_path("/file", vfs_path="file"),
        _lettered_pieces(),
    )
    assert (tmp_path / "file").read_bytes() == b"".join(
        bytes([65 + i % 26]) * (16 * 1024) for i in range(64)
    )
    assert len(writes) <= 64 * 16 * 1024 // STREAM_BATCH_BYTES + 1


@pytest.mark.asyncio
async def test_a_slow_stream_still_shows_its_bytes_within_a_flush(tmp_path):
    shown = asyncio.Event()
    seen = []

    async def source():
        yield b"first\n"
        for _ in range(50):
            await asyncio.sleep(STREAM_FLUSH_SECONDS / 2)
            if (tmp_path / "file").read_bytes():
                seen.append((tmp_path / "file").read_bytes())
                shown.set()
                break
        yield b"second\n"

    await write(
        DiskAccessor(tmp_path),
        PathSpec.from_str_path("/file", vfs_path="file"),
        source(),
    )
    assert shown.is_set()
    assert seen[0] == b"first\n"
    assert (tmp_path / "file").read_bytes() == b"first\nsecond\n"


async def _refuse(data):
    raise OSError(errno.ENOSPC, "No space left on device")


async def _refuse_slowly(data):
    await asyncio.sleep(3 * STREAM_FLUSH_SECONDS)
    await _refuse(data)


async def _brief():
    yield b"first\n"
    await asyncio.sleep(1.5 * STREAM_FLUSH_SECONDS)


@pytest.mark.asyncio
async def test_a_failed_timed_write_stops_a_writer_waiting_on_input(
    tmp_path, monkeypatch
):
    opened = disk_write.aiofiles.open
    closed = []

    async def full(*args, **kwargs):
        f = await opened(*args, **kwargs)
        f.write = _refuse
        return f

    async def stalled():
        try:
            yield b"first\n"
            await asyncio.Event().wait()
        finally:
            closed.append(True)

    monkeypatch.setattr(disk_write.aiofiles, "open", full)
    started = asyncio.get_running_loop().time()
    with pytest.raises(OSError) as caught:
        await asyncio.wait_for(
            write(
                DiskAccessor(tmp_path),
                PathSpec.from_str_path("/file", vfs_path="file"),
                stalled(),
            ),
            timeout=20 * STREAM_FLUSH_SECONDS,
        )
    assert caught.value.errno == errno.ENOSPC
    assert (
        asyncio.get_running_loop().time() - started < 10 * STREAM_FLUSH_SECONDS
    )
    assert closed == [True]
    assert asyncio.current_task().cancelling() == 0


@pytest.mark.asyncio
async def test_input_ending_during_a_failed_timed_write_reports_the_error(
    tmp_path, monkeypatch
):
    opened = disk_write.aiofiles.open

    async def slow_and_full(*args, **kwargs):
        f = await opened(*args, **kwargs)
        f.write = _refuse_slowly
        return f

    monkeypatch.setattr(disk_write.aiofiles, "open", slow_and_full)
    with pytest.raises(OSError) as caught:
        await write(
            DiskAccessor(tmp_path),
            PathSpec.from_str_path("/file", vfs_path="file"),
            _brief(),
        )
    assert caught.value.errno == errno.ENOSPC
    assert asyncio.current_task().cancelling() == 0
