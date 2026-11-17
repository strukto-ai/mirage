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
from mirage.core.posix.checksum import checksum as posix_checksum
from mirage.core.posix.utils import join_root
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


async def checksum(
    accessor: SSHAccessor,
    path_spec: PathSpec,
    algorithm: str,
) -> str | None:
    """A file's digest, by the matching coreutils sum on the server, so
    the bytes never cross the connection.

    Only an exit of 0 with nothing on stderr and one digest of the
    algorithm's length on stdout answers: a server that runs no
    commands or has no such tool, a directory or a file the tool could
    not read leaves the file to be read and hashed, which reports it.

    Args:
        accessor (SSHAccessor): the mount's connection.
        path_spec (PathSpec): the file.
        algorithm (str): the hashlib name asked for.
    """
    remote = join_root(accessor.config.root, path_spec.mount_path)
    try:
        return await posix_checksum(accessor.run, remote, algorithm)
    except (asyncssh.Error, OSError) as exc:
        logger.debug("ssh checksum left to the read: %s", exc)
        return None
