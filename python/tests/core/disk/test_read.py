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

import os
from pathlib import Path

import pytest

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk import read as disk_read
from mirage.core.disk.read import read, read_many
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _on_d(key: str) -> PathSpec:
    """The file ``key`` names on a mount at ``/d``."""
    return PathSpec(
        virtual="/d" + key,
        directory="/d" + key.rsplit("/", 1)[0] + "/",
        vfs_path=key.lstrip("/"),
    )


@pytest.mark.asyncio
async def test_read_file(tmp_path):
    (tmp_path / "hello.txt").write_bytes(b"hello world")
    accessor = DiskAccessor(tmp_path)
    result = await read(
        accessor,
        PathSpec(
            vfs_path=mount_key("/hello.txt", "/disk"),
            virtual="/hello.txt",
            directory="/hello.txt",
        ),
    )
    assert result == b"hello world"


@pytest.mark.asyncio
async def test_read_file_not_found(tmp_path):
    accessor = DiskAccessor(tmp_path)
    with pytest.raises(FileNotFoundError):
        await read(
            accessor,
            PathSpec(
                vfs_path="missing.txt",
                virtual="/missing.txt",
                directory="/missing.txt",
            ),
        )


@pytest.mark.asyncio
async def test_read_with_glob_scope_and_prefix(tmp_path):
    (tmp_path / "data.bin").write_bytes(b"\x00\x01\x02")
    accessor = DiskAccessor(tmp_path)
    scope = PathSpec(
        vfs_path=mount_key("/disk/data.bin", "/disk"),
        virtual="/disk/data.bin",
        directory="/disk/",
    )
    result = await read(accessor, scope)
    assert result == b"\x00\x01\x02"


@pytest.mark.asyncio
async def test_read_range_seeks_instead_of_reading_the_whole_file(tmp_path):
    (tmp_path / "big.bin").write_bytes(bytes(range(256)))
    accessor = DiskAccessor(tmp_path)
    result = await read(
        accessor,
        PathSpec(
            vfs_path=mount_key("/big.bin", "/disk"),
            virtual="/big.bin",
            directory="/big.bin",
        ),
        10,
        5,
    )
    assert result == bytes(range(10, 15))


@pytest.mark.asyncio
async def test_read_range_without_a_size_runs_to_the_end(tmp_path):
    (tmp_path / "big.bin").write_bytes(bytes(range(256)))
    accessor = DiskAccessor(tmp_path)
    result = await read(
        accessor,
        PathSpec(
            vfs_path=mount_key("/big.bin", "/disk"),
            virtual="/big.bin",
            directory="/big.bin",
        ),
        250,
    )
    assert result == bytes(range(250, 256))


@pytest.mark.asyncio
async def test_read_range_past_the_end_is_empty(tmp_path):
    (tmp_path / "small.bin").write_bytes(b"abc")
    accessor = DiskAccessor(tmp_path)
    result = await read(
        accessor,
        PathSpec(
            vfs_path=mount_key("/small.bin", "/disk"),
            virtual="/small.bin",
            directory="/small.bin",
        ),
        99,
        5,
    )
    assert result == b""


@pytest.mark.asyncio
async def test_read_range_missing_file_raises(tmp_path):
    accessor = DiskAccessor(tmp_path)
    with pytest.raises(FileNotFoundError):
        await read(
            accessor,
            PathSpec(
                vfs_path="missing.bin",
                virtual="/missing.bin",
                directory="/missing.bin",
            ),
            0,
            5,
        )


@pytest.mark.asyncio
async def test_read_range_records_the_virtual_path(tmp_path):
    # A directory named like its mount keeps /m/k.txt off the virtual path.
    (tmp_path / "m").mkdir()
    (tmp_path / "m" / "k.txt").write_bytes(b"hello")
    spec = PathSpec(
        virtual="/m/m/k.txt", directory="/m/m/", vfs_path="m/k.txt"
    )
    scope = RecordingScope()
    try:
        data = await read(DiskAccessor(tmp_path), spec, offset=1, size=3)
    finally:
        scope.close()
    assert data == b"ell"
    assert [r.path for r in scope.records] == ["/m/m/k.txt"]


# A path under a plain file is ENOTDIR on the real filesystem, and the
# error names the virtual path, never the host one the mount resolves to.
@pytest.mark.asyncio
async def test_read_bytes_under_a_plain_file_is_not_a_directory(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    spec = PathSpec(
        vfs_path="a.txt/x", virtual="/a.txt/x", directory="/a.txt/"
    )
    with pytest.raises(NotADirectoryError) as exc:
        await read(DiskAccessor(tmp_path), spec)
    assert exc.value.filename == "/a.txt/x"
    assert str(tmp_path) not in str(exc.value)


@pytest.mark.asyncio
async def test_a_batch_read_answers_only_the_files_their_own_reads_would(
    tmp_path,
):
    # Each file is checked as its own read checks it, so a link, a folder
    # reached through one, a name spelled unlike its entry, a directory, a
    # FIFO (whose open would wait for a writer) and a file gone or longer
    # than the limit are left for that read; the rest are recorded once
    # each, as their own reads record them, a file named twice too.
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    (tmp_path / "a" / "sub").mkdir()
    (tmp_path / "a" / "x").write_bytes(b"x\n")
    (tmp_path / "a" / "y").write_bytes(b"y\n")
    (tmp_path / "a" / "long").write_bytes(b"z" * 9)
    (tmp_path / "b" / "c").write_bytes(b"c\n")
    (tmp_path / "a" / "link").symlink_to(tmp_path / "a" / "x")
    (tmp_path / "linked").symlink_to(tmp_path / "a")
    os.mkfifo(tmp_path / "a" / "pipe")
    keys = [
        "/a/x",
        "/a/link",
        "/linked/y",
        "/a/X",
        "/a/sub",
        "/a/pipe",
        "/a/gone",
        "/a/long",
        "/gone/x",
        "/a/y",
        "/b/c",
        "/a/x",
    ]
    scope = RecordingScope()
    try:
        got = await read_many(
            DiskAccessor(tmp_path), [_on_d(k) for k in keys], 8
        )
    finally:
        scope.close()
    assert got == {"/d/a/x": b"x\n", "/d/a/y": b"y\n", "/d/b/c": b"c\n"}
    assert [(r.path, r.bytes, r.complete) for r in scope.records] == [
        ("/d/a/x", 2, True),
        ("/d/a/y", 2, True),
        ("/d/b/c", 2, True),
    ]


@pytest.mark.asyncio
async def test_a_batch_read_keeps_the_files_that_fit_its_room(tmp_path):
    # A file that would take the batch past its room is left out before
    # it is read, and a smaller one after it still fits.
    for name, size in (("f", 16), ("g", 16), ("h", 4)):
        (tmp_path / name).write_bytes(b"x" * size)
    accessor = DiskAccessor(tmp_path)
    files = [_on_d("/f"), _on_d("/g"), _on_d("/h")]
    assert sorted(await read_many(accessor, files, 64, 20)) == [
        "/d/f",
        "/d/h",
    ]
    assert await read_many(accessor, files, 64, -1) == {}
    assert len(await read_many(accessor, files, 64)) == 3


@pytest.mark.asyncio
async def test_a_batch_read_reads_on_past_a_short_read(tmp_path, monkeypatch):
    # A read may answer fewer bytes than it was asked for before the end of
    # the file, so the batch reads again until a read answers none.
    (tmp_path / "f").write_bytes(b"0123456789")
    calls: list[int] = []
    real = os.read

    def short(fd: int, n: int) -> bytes:
        calls.append(n)
        return real(fd, min(n, 3))

    monkeypatch.setattr(os, "read", short)
    got = await read_many(DiskAccessor(tmp_path), [_on_d("/f")], 64)
    monkeypatch.undo()
    assert got == {"/d/f": b"0123456789"}
    assert len(calls) > 1


@pytest.mark.asyncio
async def test_a_batch_read_proves_a_leaf_is_no_link_where_the_open_cannot(
    tmp_path, monkeypatch
):
    # Without O_NOFOLLOW (Windows) the open would follow a link at the
    # leaf, so the batch looks at the name first and keeps a file only when
    # the open reached the very file it saw.
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "x").write_bytes(b"x\n")
    (tmp_path / "a" / "link").symlink_to(tmp_path / "a" / "x")
    monkeypatch.setattr(disk_read, "_OPEN_REFUSES_LINK", False)
    monkeypatch.setattr(
        disk_read, "_OPEN_CHECKED", os.O_RDONLY | os.O_NONBLOCK
    )
    got = await read_many(
        DiskAccessor(tmp_path), [_on_d("/a/x"), _on_d("/a/link")], 8
    )
    assert got == {"/d/a/x": b"x\n"}


@pytest.mark.asyncio
async def test_a_batch_read_refuses_a_folder_swapped_for_a_link_mid_batch(
    tmp_path, monkeypatch
):
    # The batch proves /a once, so a file opened after /a was swapped for
    # a link to a folder outside the mount would come from outside; once
    # each file is open the folder's path must still name the directory
    # proven, so /a/y is left for its own read, which refuses the link.
    root = tmp_path / "root"
    (root / "a").mkdir(parents=True)
    (root / "a" / "x").write_bytes(b"x\n")
    (root / "a" / "y").write_bytes(b"y\n")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "y").write_bytes(b"outside\n")
    real = disk_read.exact_name
    swapped: list[bool] = []

    def swapping(
        parent: str,
        part: str,
        info: os.stat_result,
        opened: set[str] | None = None,
    ) -> bool:
        exact = real(parent, part, info, opened)
        if not swapped:
            swapped.append(True)
            os.rename(root / "a", tmp_path / "moved")
            os.symlink(outside, root / "a")
        return exact

    monkeypatch.setattr(disk_read, "exact_name", swapping)
    got = await read_many(
        DiskAccessor(root), [_on_d("/a/x"), _on_d("/a/y")], 8
    )
    assert got == {"/d/a/x": b"x\n"}


@pytest.mark.asyncio
async def test_a_batch_read_leaves_out_a_name_the_host_cannot_open(tmp_path):
    # A name holding a NUL passes its folder's check but no host call takes
    # it; that file is left for its own read, and the rest of the batch is
    # still read and recorded.
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "x").write_bytes(b"x\n")
    scope = RecordingScope()
    try:
        got = await read_many(
            DiskAccessor(tmp_path), [_on_d("/a/n\x00ul"), _on_d("/a/x")], 8
        )
    finally:
        scope.close()
    assert got == {"/d/a/x": b"x\n"}
    assert [r.path for r in scope.records] == ["/d/a/x"]


@pytest.mark.asyncio
async def test_a_batch_read_refuses_a_folder_swapped_right_after_its_proof(
    tmp_path, monkeypatch
):
    # The batch keeps a folder's identity to check each file's folder
    # against; taken after the proof, it could be of a folder swapped for a
    # link to one outside the mount in between, and every file would then
    # come from outside. It is taken before the proof, so a swap right
    # after it is caught when the file's folder is checked.
    root = tmp_path / "root"
    (root / "a").mkdir(parents=True)
    (root / "a" / "x").write_bytes(b"x\n")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "x").write_bytes(b"outside\n")
    real = disk_read.resolve_inside_sync
    swapped: list[bool] = []

    def swapping(
        root_: Path,
        spec: PathSpec,
        path: str | None = None,
        opened: set[str] | None = None,
    ) -> Path:
        host = real(root_, spec, path, opened)
        if not swapped:
            swapped.append(True)
            os.rename(root / "a", tmp_path / "moved")
            os.symlink(outside, root / "a")
        return host

    monkeypatch.setattr(disk_read, "resolve_inside_sync", swapping)
    got = await read_many(DiskAccessor(root), [_on_d("/a/x")], 8)
    assert swapped
    assert got == {}
