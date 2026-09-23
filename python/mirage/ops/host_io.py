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

from collections.abc import AsyncIterator, Iterator
from contextlib import contextmanager
from threading import Lock
from typing import TypeVar

T = TypeVar("T")

# Whether a backend is serving an op, in which case the patched `open`
# and `os` doors (ops/open.py, ops/os_patch.py) answer nothing. Those
# doors are for the embedding program's own code; a backend reaching the
# host filesystem is not that code, and the path it reaches for is a
# physical one even when a mount is spelled the same way.
#
# They can be spelled the same: a disk mount whose root sits at or under
# its own virtual prefix (`{"/data/": DiskVFS(root="/data")}`) hands
# the host a path `is_mounted` answers True for, so the door routed it
# back into the workspace, back into the same backend, forever. No
# string tells the two apart, so the caller is the only signal there is.
#
# A depth, not a flag: an op whose core function runs another op's nests,
# and a flag would clear the bypass when the inner one returned.
#
# Process-global, not a ContextVar, because the hop a backend makes has
# to be covered and half of them drop a context: `asyncio.to_thread`
# copies one, but `loop.run_in_executor` does not, and that is what
# aiofiles' `os.path.exists` / `os.stat` wrappers use, which is most of
# the disk core's host I/O. The cost is that the bypass is up for every
# thread while an op is being served, so an unrelated thread's own call
# on a mounted path reaches the host for that window. That is the
# narrower failure: it needs a second thread touching a mount at the
# same moment, where routing a backend's physical path back into itself
# hangs the process every time.
_lock = Lock()
_depth = 0


def in_host_io() -> bool:
    """Whether a backend is serving an op, so the doors stay shut."""
    return _depth > 0


@contextmanager
def host_io() -> Iterator[None]:
    """Run a backend call with the patched `open`/`os` doors transparent."""
    global _depth
    with _lock:
        _depth += 1
    try:
        yield
    finally:
        with _lock:
            _depth -= 1


async def with_host_io(it: AsyncIterator[T]) -> AsyncIterator[T]:
    """Wrap a backend iterator so each item is produced inside `host_io`.

    A backend that yields is only inside its own frame while an item is
    being pulled: the body of ``read_stream`` opens the file on the
    first ``__anext__``, long after the op call that created it
    returned. Mirrors ``with_mount_prefix``, which wraps the same
    streams for the same reason. Generic because a walk yields entries
    where a read yields chunks, and both are the backend's own frame.

    Args:
        it (AsyncIterator[T]): the backend iterator to wrap.
    """
    aiter = it.__aiter__()
    try:
        while True:
            with host_io():
                try:
                    item = await aiter.__anext__()
                except StopAsyncIteration:
                    return
            yield item
    finally:
        close = getattr(aiter, "aclose", None)
        if close is not None:
            # Closing is the backend's frame too: an unfinished stream
            # unwinds an `async with` on the host file it opened.
            with host_io():
                await close()
