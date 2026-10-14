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

import asyncssh

from mirage.accessor.ssh import SSHAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.ssh.utils import join_root
from mirage.errors.fs import enoent
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.quote import single_quote

logger = logging.getLogger(__name__)

WC = "env LC_ALL=C wc -l"


async def read(
    accessor: SSHAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    virtual = path_spec.virtual
    path = path_spec.mount_path
    config = accessor.config
    sftp = await accessor.sftp()
    timer = start_op()
    try:
        remote_path = join_root(config.root, path)
        async with sftp.open(remote_path, "rb") as f:
            if offset:
                await f.seek(offset)
            raw = await f.read(size if size is not None else -1)
        data = raw if isinstance(raw, bytes) else raw.encode()
        record("read", virtual, "ssh", len(data), timer)
        return data
    except asyncssh.SFTPNoSuchFile:
        raise enoent(virtual)


async def line_count(
    accessor: SSHAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> int | None:
    """How many newlines a file holds, by wc on the server.

    Only an exit of 0 with nothing on stderr and one count on stdout
    answers: a server that runs no commands, a directory or a file wc
    could not read leaves the file to be read, which reports it.

    Args:
        accessor (SSHAccessor): the mount's connection.
        path_spec (PathSpec): the file.
        index (IndexCacheStore): unused; wc answers directly.
    """
    remote = join_root(accessor.config.root, path_spec.mount_path)
    try:
        status, out, err = await accessor.run(f"{WC} < {single_quote(remote)}")
    except (asyncssh.Error, OSError) as exc:
        logger.debug("ssh line count left to the read: %s", exc)
        return None
    count = out.strip()
    if status != 0 or err or not out.endswith(b"\n") or not count.isdigit():
        return None
    return int(count)
