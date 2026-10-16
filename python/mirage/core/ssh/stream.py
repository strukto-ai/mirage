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
from collections.abc import AsyncIterator

import asyncssh

from mirage.accessor.ssh import SSHAccessor
from mirage.core.ssh.utils import join_root
from mirage.errors.fs import enoent
from mirage.types import PathSpec
from mirage.utils.quote import single_quote

logger = logging.getLogger(__name__)

FOLLOWABLE = "test -f {path} && test -r {path} && command -v tail >/dev/null"
FOLLOW = "exec tail -n {n} -f -- {path}"


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

    One short command asks the server for a regular file it can read at
    the path and a tail to run; anything else (a server that runs no
    commands or has no tail, a missing file, a directory) leaves the file
    to tail's poll, which reports it. The server's ``tail -f`` starts at
    the first pull and ends when the stream closes, so a stream closed
    before it is pulled leaves nothing running. The bytes are the server
    tail's own: whole lines, and the last line as it stands while the file
    has not ended it, as a tail there prints them. The server's tail waits
    for growth its own way (inotify where it has it), so ``interval`` goes
    unused, and what it says on stderr (a truncation) is not shown.

    Args:
        accessor (SSHAccessor): the mount's connection.
        path_spec (PathSpec): the file.
        n (int): how many of its last lines come first, 0 for none.
        interval (float): unused; the server's tail waits by itself.
    """
    remote = single_quote(
        join_root(accessor.config.root, path_spec.mount_path)
    )
    try:
        status, out, err = await accessor.run(FOLLOWABLE.format(path=remote))
    except (asyncssh.Error, OSError) as exc:
        logger.debug("ssh follow left to the poll: %s", exc)
        return None
    if status != 0 or out or err:
        return None
    return _followed(accessor, FOLLOW.format(path=remote, n=n))


async def _followed(
    accessor: SSHAccessor, command: str
) -> AsyncIterator[bytes]:
    """The server tail's output, its command started at the first pull and
    closed however the caller stops.

    Args:
        accessor (SSHAccessor): the mount's connection.
        command (str): the server's ``tail -f``.
    """
    stream = accessor.run_stream(command)
    try:
        async for chunk in stream:
            yield chunk
    finally:
        await stream.aclose()
