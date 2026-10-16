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

import logging
from collections.abc import AsyncGenerator, AsyncIterator

import asyncssh

from mirage.accessor.ssh import SSHAccessor
from mirage.core.ssh.utils import join_root
from mirage.errors.fs import enoent
from mirage.types import PathSpec
from mirage.utils.quote import single_quote

logger = logging.getLogger(__name__)

FOLLOW = (
    "test -f {path} && test -r {path} && command -v tail >/dev/null"
    " && echo && exec tail -n {n} -f -- {path}"
)


async def read_stream(
    accessor: SSHAccessor,
    path_spec: PathSpec,
    chunk_size: int = 8192,
):
    virtual = path_spec.virtual
    path = path_spec.mount_path
    config = accessor.config
    sftp = await accessor.sftp()
    try:
        remote_path = join_root(config.root, path)
        async with sftp.open(remote_path, "rb") as f:
            while True:
                chunk = await f.read(chunk_size)
                if not chunk:
                    break
                yield chunk
    except asyncssh.SFTPNoSuchFile:
        raise enoent(virtual)


async def follow(
    accessor: SSHAccessor,
    path_spec: PathSpec,
    n: int,
    interval: float,
) -> AsyncIterator[bytes] | None:
    """The file's last ``n`` lines, then each line added to it, from
    ``tail -f`` on the server over the mount's connection, so the file is
    not read again on each poll.

    The shell runs tail only once it finds a regular file it can read at
    the path and a tail to run, and says so with an empty line first;
    anything else (a server that runs no commands or has no tail, a
    missing file, a directory) leaves the file to tail's poll, which
    reports it. The bytes are the server tail's own: whole lines, and the
    last line as it stands while the file has not ended it, as a tail
    there prints them. The server's tail waits for growth its own way
    (inotify where it has it), so ``interval`` goes unused, and what it
    says on stderr (a truncation) is not shown.

    Args:
        accessor (SSHAccessor): the mount's connection.
        path_spec (PathSpec): the file.
        n (int): how many of its last lines come first, 0 for none.
        interval (float): unused; the server's tail waits by itself.
    """
    remote = single_quote(
        join_root(accessor.config.root, path_spec.mount_path)
    )
    stream = accessor.run_stream(FOLLOW.format(path=remote, n=n))
    try:
        first = await anext(stream, b"")
    except (asyncssh.Error, OSError) as exc:
        logger.debug("ssh follow left to the poll: %s", exc)
        await stream.aclose()
        return None
    if not first.startswith(b"\n"):
        await stream.aclose()
        return None
    return _followed(first[1:], stream)


async def _followed(
    head: bytes, stream: AsyncGenerator[bytes, None]
) -> AsyncIterator[bytes]:
    """``head``, then the rest of ``stream``, which closes however the
    caller stops.

    Args:
        head (bytes): what came after the shell's empty line.
        stream (AsyncGenerator[bytes, None]): the remote tail's output.
    """
    try:
        if head:
            yield head
        async for chunk in stream:
            yield chunk
    finally:
        await stream.aclose()
