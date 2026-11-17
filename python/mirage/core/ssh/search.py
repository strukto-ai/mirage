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
from mirage.core.posix.search import (
    files_containing as posix_files_containing,
)
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


async def files_containing(
    accessor: SSHAccessor,
    text: str,
    under: list[PathSpec],
    ignore_case: bool,
) -> list[PathSpec] | None:
    """The files under ``under`` whose bytes hold ``text``, as grep on the
    server finds them.

    The answer is exact, since every file is searched, so a whole word
    is asked as plain text: a file the word only sits inside is one more
    read. Only an exit of 0 or 1 with nothing on stderr, and output that
    is NUL-ended names, answers: a server that runs no commands (one
    forced to internal-sftp says so on stdout and exits 1), a grep that
    refuses an option (busybox exits 1 for one), or a file it could not
    read (which the walk then reports) leaves every file to be read.

    Args:
        accessor (SSHAccessor): the mount's connection.
        text (str): the plain text.
        under (list[PathSpec]): the directories walked.
        ignore_case (bool): fold ASCII case, which is all the text needs.
    """
    try:
        return await posix_files_containing(
            accessor.run, accessor.config.root, text, under, ignore_case
        )
    except (asyncssh.Error, OSError) as exc:
        logger.debug("ssh search left to the scan: %s", exc)
        return None
