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
import time
import tracemalloc

import pytest

from mirage.accessor.ram import RAMAccessor
from mirage.core.dev.pipe import DevicePipe
from mirage.core.ram.constants import STREAM_PUBLISH_SECONDS
from mirage.core.ram.unlink import unlink
from mirage.core.ram.write import write
from mirage.errors.types import QuotaExceededError
from mirage.types import PathSpec
from mirage.vfs.dev.store import DevFiles, DevStore
from mirage.vfs.ram.store import RAMStore
from tests.fixtures.held_loop import HeldLoop, run_on_held_loop
from tests.fixtures.ram_capacity import capped, ram_path, table_bytes


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


async def _blocks(count: int):
    for _ in range(count):
        yield b"a" * 16384


@pytest.mark.asyncio
async def test_a_stream_into_a_discarding_device_keeps_nothing():
    store = DevStore(DevFiles("owner"))
    null = PathSpec(vfs_path="null", virtual="/dev/null", directory="/dev/")
    tracemalloc.start()
    try:
        await write(RAMAccessor(store), null, _blocks(256))
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 1 << 20
    assert store.files["/null"] == b""


def test_the_publish_interval_is_spent_on_the_loop_clock():
    # Real time passing between chunks does not publish them on a loop
    # whose clock stood still; the end of the write does.
    accessor = RAMAccessor(RAMStore())
    seen: list[bytes] = []

    async def chunks():
        yield b"a"
        time.sleep(STREAM_PUBLISH_SECONDS * 2)
        yield b"b"
        seen.append(accessor.store.files["/log"])
        yield b"c"

    async def main(loop: HeldLoop) -> bytes:
        await write(accessor, _spec("log"), chunks())
        return accessor.store.files["/log"]

    assert run_on_held_loop(main) == b"abc"
    assert seen == [b""]


@pytest.mark.asyncio
async def test_a_capped_bytes_write_charges_what_it_adds():
    accessor, usage = capped(10, {"/old": b"123"})
    await write(accessor, ram_path("/f"), b"1234")
    await write(accessor, ram_path("/f"), b"12", append=True)
    assert usage.used == table_bytes(accessor) == 9


@pytest.mark.asyncio
async def test_a_refused_bytes_write_leaves_the_table_as_it_was():
    accessor, usage = capped(10, {"/f": b"12345678"})
    with pytest.raises(QuotaExceededError) as err:
        await write(accessor, ram_path("/g"), b"123")
    assert err.value.filename == "/g"
    assert "/g" not in accessor.store.files
    assert usage.used == table_bytes(accessor) == 8


@pytest.mark.asyncio
async def test_an_overwrite_that_shrinks_passes_over_the_cap():
    accessor, usage = capped(5, {"/f": b"1234567890"})
    await write(accessor, ram_path("/f"), b"123456789")
    with pytest.raises(QuotaExceededError):
        await write(accessor, ram_path("/f"), b"1", append=True)
    assert usage.used == table_bytes(accessor) == 9


@pytest.mark.asyncio
async def test_an_atomic_stream_charges_its_growth_once():
    accessor, usage = capped(10, {"/f": b"12345678"})
    await write(
        accessor, ram_path("/f"), _chunks_of(b"12345", b"6789"), atomic=True
    )
    assert accessor.store.files["/f"] == b"123456789"
    assert usage.used == table_bytes(accessor) == 9


@pytest.mark.asyncio
async def test_a_stream_refused_midway_keeps_the_chunks_before():
    accessor, usage = capped(10)
    with pytest.raises(QuotaExceededError):
        await write(
            accessor, ram_path("/s"), _chunks_of(b"1234", b"5678", b"9abc")
        )
    assert accessor.store.files["/s"] == b"12345678"
    assert (usage.used, usage.pending) == (8, 0)


async def _bytes_then_text():
    yield b"1234"
    yield "5678"


@pytest.mark.asyncio
async def test_a_publish_that_fails_to_join_its_chunks_holds_nothing():
    accessor, usage = capped(10)
    with pytest.raises(TypeError):
        await write(accessor, ram_path("/s"), _bytes_then_text())
    assert (usage.used, usage.pending) == (0, 0)
    await write(accessor, ram_path("/t"), b"x" * 10)


async def _unjoinable_then(tail: bytes | None):
    yield b"1234"
    yield "5678"
    await asyncio.sleep(STREAM_PUBLISH_SECONDS * 3)
    if tail is not None:
        yield tail


@pytest.mark.asyncio
@pytest.mark.parametrize("tail", [b"9999", None], ids=["more", "end"])
async def test_a_timer_publish_that_fails_fails_the_write(tail):
    accessor, usage = capped(100)
    with pytest.raises(TypeError):
        await write(accessor, ram_path("/s"), _unjoinable_then(tail))
    assert accessor.store.files["/s"] == b""
    assert (usage.used, usage.pending) == (0, 0)


@pytest.mark.asyncio
async def test_a_stream_counts_the_change_its_splice_made():
    accessor, usage = capped(100)
    hold = asyncio.Event()

    async def source():
        yield b"aaaa"
        await hold.wait()
        yield b"bb"

    writing = asyncio.create_task(write(accessor, ram_path("/s"), source()))
    await asyncio.sleep(STREAM_PUBLISH_SECONDS * 3)
    await write(accessor, ram_path("/s"), b"xxxxxxxx")
    hold.set()
    await writing
    assert accessor.store.files["/s"] == b"xxxxbbxx"
    assert (usage.used, usage.pending) == (8, 0)
    assert usage.used == table_bytes(accessor)


@pytest.mark.asyncio
async def test_a_shortened_stream_pads_its_gap_counted_not_admitted():
    accessor, usage = capped(5)
    hold = asyncio.Event()

    async def source():
        yield b"aaaa"
        await hold.wait()
        yield b"b"

    writing = asyncio.create_task(write(accessor, ram_path("/s"), source()))
    await asyncio.sleep(STREAM_PUBLISH_SECONDS * 3)
    await unlink(accessor, ram_path("/s"))
    hold.set()
    await writing
    assert accessor.store.files["/s"] == b"\0\0\0\0b"
    assert usage.used == table_bytes(accessor) == 5
    with pytest.raises(QuotaExceededError):
        await write(accessor, ram_path("/t"), b"1")


@pytest.mark.asyncio
async def test_a_replacing_stream_gives_back_the_old_bytes_first():
    accessor, usage = capped(10, {"/s": b"12345678"})
    await write(accessor, ram_path("/s"), _chunks_of(b"abc", b"def"))
    assert accessor.store.files["/s"] == b"abcdef"
    assert (usage.used, usage.pending) == (6, 0)
