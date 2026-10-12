import asyncio
import errno

import pytest

from mirage.core.dev.pipe import DevicePipe
from mirage.io.errors import PipeClosed
from mirage.io.pipe import CAPACITY
from mirage.types import MountMode, PathSpec
from mirage.vfs.dev.dev import DevVFS
from mirage.vfs.dev.store import DevFiles
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

PATH = PathSpec.from_str_path("/dev/fd/63")


async def _drain(endpoint: DevicePipe, seen: list[bytes]) -> None:
    async for chunk in endpoint.stream(PATH):
        seen.append(chunk)


@pytest.mark.asyncio
async def test_pipe_is_bounded_and_early_close_wakes_writer():
    endpoint = DevicePipe(True)
    writing = asyncio.create_task(endpoint.pipe.write(b"x" * (CAPACITY * 4)))
    await asyncio.sleep(0)
    assert endpoint.pipe.buffered_bytes <= CAPACITY
    assert not writing.done()
    assert await endpoint.read(PATH, 3) == b"xxx"
    stream = endpoint.stream(PATH)
    assert await anext(stream)
    await stream.aclose()
    await asyncio.sleep(0)
    assert not endpoint.pipe.closed_reader
    assert not writing.done()
    endpoint.pipe.close_reader()
    with pytest.raises(PipeClosed):
        await writing
    assert endpoint.pipe.buffered_bytes == 0


@pytest.mark.asyncio
async def test_end_preserves_pending_bytes_and_rejects_wrong_direction():
    endpoint = DevicePipe(True)
    await endpoint.pipe.write(b"abcdef")
    endpoint.pipe.end()
    assert await endpoint.read(PATH, 2) == b"ab"
    assert (
        b"".join([chunk async for chunk in endpoint.stream(PATH)]) == b"cdef"
    )
    with pytest.raises(OSError) as caught:
        await endpoint.write(b"x", PATH)
    assert caught.value.errno == errno.EBADF
    output = DevicePipe(False)
    with pytest.raises(OSError) as caught:
        await output.read(PATH)
    assert caught.value.errno == errno.EBADF


@pytest.mark.asyncio
async def test_concurrent_readers_take_turns_by_chunk():
    endpoint = DevicePipe(True)
    left: list[bytes] = []
    right: list[bytes] = []
    readers = asyncio.gather(_drain(endpoint, left), _drain(endpoint, right))
    for chunk in (b"one", b"two", b"three"):
        await asyncio.sleep(0)
        await endpoint.pipe.write(chunk)
    endpoint.pipe.end()
    await asyncio.wait_for(readers, 3)
    assert sorted(left + right) == [b"one", b"three", b"two"]


@pytest.mark.asyncio
async def test_abandoned_reader_keeps_the_read_end_open():
    endpoint = DevicePipe(True)
    await endpoint.pipe.write(b"first")
    await endpoint.pipe.write(b"second")
    endpoint.pipe.end()
    stream = endpoint.stream(PATH)
    assert await anext(stream) == b"first"
    await stream.aclose()
    assert not endpoint.pipe.closed_reader
    assert await endpoint.read(PATH) == b"second"


@pytest.mark.asyncio
async def test_cancelled_reader_leaves_its_chunk_to_the_next_reader():
    endpoint = DevicePipe(True)
    waiting = asyncio.create_task(endpoint.read(PATH))
    await asyncio.sleep(0)
    waiting.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiting
    await endpoint.pipe.write(b"data")
    endpoint.pipe.end()
    assert not endpoint.pipe.closed_reader
    assert await asyncio.wait_for(endpoint.read(PATH), 3) == b"data"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command,expected",
    [
        (
            'f() { cat "$1" & cat "$1"; wait; }; f <(sleep 0.2; printf data)',
            "data",
        ),
        (
            'f() { head -c 1 "$1"; echo; cat "$1"; }; '
            "f <(printf a; sleep 0.2; printf rest)",
            "a\nrest",
        ),
        ('f() { cat "$1"; cat "$1"; }; f <(printf once)', "once"),
    ],
)
async def test_function_readers_share_one_substitution(command, expected):
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        io = await asyncio.wait_for(ws.shell(command), 5)
        assert (
            io.exit_code,
            await io.stdout_str(),
            await io.stderr_str(),
        ) == (0, expected, "")
        dev, _, _ = ws.registry.resolve("/dev/null")
        assert isinstance(dev, DevVFS)
        assert dev._store.files.state.inputs == {}
    finally:
        await ws.close()


def test_session_views_share_files_but_hide_each_others_descriptors():
    root = DevFiles()
    left, right = root.for_session("left"), root.for_session("right")
    endpoint = DevicePipe(True)
    path, allocation = left.allocate_input(endpoint)
    assert left.pipe_of(path[4:]) is endpoint
    assert path[4:] not in right
    assert right.pipe_of(path[4:]) is None
    left["/ordinary"] = b"shared"
    assert right["/ordinary"] == b"shared"
    assert left.release_input(path, allocation)
    replacement, next_allocation = right.allocate_input(DevicePipe(False))
    assert replacement == path
    assert not left.release_input(path, allocation)
    assert right.release_input(replacement, next_allocation)
