import asyncio
import errno

import pytest

from mirage.core.dev.pipe import DevicePipe
from mirage.io.errors import PipeClosed
from mirage.io.pipe import CAPACITY
from mirage.types import PathSpec
from mirage.vfs.dev.store import DevFiles

PATH = PathSpec.from_str_path("/dev/fd/63")


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
