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

import pytest

from mirage.accessor.ram import RAMAccessor
from mirage.core.dev.pipe import DevicePipe
from mirage.core.ram.constants import STREAM_PUBLISH_SECONDS
from mirage.core.ram.write import write
from mirage.types import PathSpec
from mirage.vfs.dev.store import DevFiles, DevStore
from mirage.vfs.ram.store import RAMStore


@pytest.fixture
def store():
    s = RAMStore()

    a = RAMAccessor(s)
    s.dirs.add("/sub")
    return a


@pytest.mark.asyncio
async def test_write_bytes(store):
    await write(
        store,
        PathSpec(
            vfs_path="hello.txt", virtual="/hello.txt", directory="/hello.txt"
        ),
        b"hello",
    )
    assert store.store.files["/hello.txt"] == b"hello"
    assert "/hello.txt" in store.store.modified
    assert store.store.modified["/hello.txt"].endswith("Z")
    assert "+00:00" not in store.store.modified["/hello.txt"]


@pytest.mark.asyncio
async def test_write_bytes_overwrite(store):
    await write(
        store,
        PathSpec(
            vfs_path="file.txt", virtual="/file.txt", directory="/file.txt"
        ),
        b"first",
    )
    await write(
        store,
        PathSpec(
            vfs_path="file.txt", virtual="/file.txt", directory="/file.txt"
        ),
        b"second",
    )
    assert store.store.files["/file.txt"] == b"second"


@pytest.mark.asyncio
async def test_write_bytes_parent_not_found():
    s = RAMStore()

    a = RAMAccessor(s)
    # The operand is what a GNU stderr line names, so the error carries the
    # virtual path, not the internal "parent does not exist" phrasing.
    with pytest.raises(FileNotFoundError, match="/no/parent/file.txt"):
        await write(
            a,
            PathSpec(
                vfs_path="no/parent/file.txt",
                virtual="/no/parent/file.txt",
                directory="/no/parent/file.txt",
            ),
            b"data",
        )
    assert "/no/parent/file.txt" not in s.files


@pytest.mark.asyncio
async def test_write_bytes_under_a_plain_file_is_not_a_directory():
    s = RAMStore()
    s.files["/plain"] = b"x"

    a = RAMAccessor(s)
    with pytest.raises(NotADirectoryError):
        await write(
            a,
            PathSpec(
                vfs_path="plain/file.txt",
                virtual="/plain/file.txt",
                directory="/plain/file.txt",
            ),
            b"data",
        )
    assert "/plain/file.txt" not in s.files


@pytest.mark.asyncio
async def test_write_bytes_deep_under_a_plain_file_is_not_a_directory():
    s = RAMStore()
    s.files["/plain"] = b"x"

    a = RAMAccessor(s)
    with pytest.raises(NotADirectoryError):
        await write(
            a,
            PathSpec(
                vfs_path="plain/sub/file.txt",
                virtual="/plain/sub/file.txt",
                directory="/plain/sub/file.txt",
            ),
            b"data",
        )


@pytest.mark.asyncio
async def test_write_bytes_onto_a_directory_is_a_directory(store):
    with pytest.raises(IsADirectoryError):
        await write(store, PathSpec.from_str_path("/sub"), b"data")
    assert "/sub" not in store.store.files
    assert "/sub" in store.store.dirs


@pytest.mark.asyncio
async def test_an_append_onto_a_directory_is_a_directory(store):
    with pytest.raises(IsADirectoryError):
        await write(
            store, PathSpec.from_str_path("/sub"), b"data", append=True
        )
    assert "/sub" not in store.store.files


@pytest.mark.asyncio
async def test_write_bytes_to_subdir(store):
    await write(
        store,
        PathSpec(
            vfs_path="sub/file.txt",
            virtual="/sub/file.txt",
            directory="/sub/file.txt",
        ),
        b"nested data",
    )
    assert store.store.files["/sub/file.txt"] == b"nested data"


@pytest.mark.asyncio
async def test_write_bytes_root_parent():
    s = RAMStore()

    a = RAMAccessor(s)
    await write(
        a,
        PathSpec(
            vfs_path="root_file.txt",
            virtual="/root_file.txt",
            directory="/root_file.txt",
        ),
        b"root",
    )
    assert s.files["/root_file.txt"] == b"root"


@pytest.mark.asyncio
async def test_write_bytes_sets_modified(store):
    await write(
        store,
        PathSpec(
            vfs_path="file.txt", virtual="/file.txt", directory="/file.txt"
        ),
        b"data",
    )
    assert store.store.modified["/file.txt"] is not None


def _spec(name: str) -> PathSpec:
    return PathSpec(vfs_path=name, virtual=f"/{name}", directory=f"/{name}")


async def _quiet(chunks: list[bytes], hold: asyncio.Event):
    for chunk in chunks:
        yield chunk
    await hold.wait()


async def _chunks_of(*chunks: bytes):
    for chunk in chunks:
        yield chunk


async def _broken():
    yield b"kept\n"
    raise OSError("source gone")


# A writer that goes quiet still shows what it wrote within the publish
# interval, so a reader watches a slow program's log grow.
@pytest.mark.asyncio
async def test_a_streamed_write_shows_a_quiet_writers_bytes(store):
    hold = asyncio.Event()
    writing = asyncio.create_task(
        write(store, _spec("log"), _quiet([b"a\n", b"b\n"], hold))
    )
    await asyncio.sleep(STREAM_PUBLISH_SECONDS * 3)
    assert store.store.files["/log"] == b"a\nb\n"
    hold.set()
    await writing
    assert store.store.files["/log"] == b"a\nb\n"


# A streamed append lands after what another appender added meanwhile.
@pytest.mark.asyncio
async def test_a_streamed_append_keeps_another_appenders_bytes(store):
    store.store.files["/log"] = b"start\n"
    hold = asyncio.Event()
    writing = asyncio.create_task(
        write(store, _spec("log"), _quiet([b"mine\n"], hold), append=True)
    )
    await asyncio.sleep(STREAM_PUBLISH_SECONDS * 3)
    await write(store, _spec("log"), b"theirs\n", append=True)
    hold.set()
    await writing
    assert store.store.files["/log"] == b"start\nmine\ntheirs\n"


# An atomic write shows nothing until it ends whole.
@pytest.mark.asyncio
async def test_an_atomic_streamed_write_lands_at_its_end(store):
    store.store.files["/f"] = b"old"
    hold = asyncio.Event()
    writing = asyncio.create_task(
        write(store, _spec("f"), _quiet([b"new"], hold), atomic=True)
    )
    await asyncio.sleep(STREAM_PUBLISH_SECONDS * 3)
    assert store.store.files["/f"] == b"old"
    hold.set()
    await writing
    assert store.store.files["/f"] == b"new"


# A stream that fails keeps what it had delivered, as a disk file does.
@pytest.mark.asyncio
async def test_a_failed_streamed_write_keeps_what_arrived(store):
    with pytest.raises(OSError):
        await write(store, _spec("f"), _broken())
    assert store.store.files["/f"] == b"kept\n"


# A replacement writes at its own position, as an open file's offset keeps
# it: a truncation behind its back leaves a hole up to where it writes next.
@pytest.mark.asyncio
async def test_a_streamed_replacement_keeps_its_position(store):
    hold = asyncio.Event()
    second = asyncio.Event()

    async def source():
        yield b"a\n"
        await second.wait()
        yield b"b\n"
        await hold.wait()

    writing = asyncio.create_task(write(store, _spec("f"), source()))
    await asyncio.sleep(STREAM_PUBLISH_SECONDS * 3)
    assert store.store.files["/f"] == b"a\n"
    store.store.files["/f"] = b""
    second.set()
    hold.set()
    await writing
    assert store.store.files["/f"] == b"\0\0b\n"


# An append that brings nothing leaves an existing file as it was, its
# modification time included (`true >> f`), and creates a missing one.
@pytest.mark.asyncio
async def test_an_empty_streamed_append_leaves_the_file_alone(store):
    store.store.files["/f"] = b"kept"
    store.store.modified["/f"] = "2020-01-01T00:00:00Z"
    await write(store, _spec("f"), _chunks_of(), append=True)
    assert store.store.files["/f"] == b"kept"
    assert store.store.modified["/f"] == "2020-01-01T00:00:00Z"
    await write(store, _spec("new"), _chunks_of(), append=True)
    assert store.store.files["/new"] == b""


@pytest.mark.asyncio
@pytest.mark.parametrize("data", [b"", b"x"])
async def test_a_write_into_an_input_pipe_is_refused_even_empty(data):
    files = DevFiles("owner")
    path, _ = files.allocate_input(DevicePipe(True))
    accessor = RAMAccessor(DevStore(files))
    with pytest.raises(OSError) as caught:
        await write(accessor, PathSpec.from_str_path(path[4:]), data)
    assert caught.value.errno == errno.EBADF
