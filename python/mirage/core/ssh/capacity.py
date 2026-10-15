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
from mirage.core.ssh.utils import join_root
from mirage.types import CapacityResult, CapacityState

logger = logging.getLogger(__name__)


async def capacity(accessor: SSHAccessor) -> CapacityResult:
    """The space of the filesystem the mount's root sits on, for df, from
    the server's statvfs, counted the way df counts a disk. A server
    without the statvfs extension is UNKNOWN.

    Args:
        accessor (SSHAccessor): the mount's connection.
    """
    sftp = await accessor.sftp()
    try:
        st = await sftp.statvfs(join_root(accessor.config.root, "/"))
    except asyncssh.SFTPError as exc:
        logger.debug("ssh statvfs unanswered: %s", exc)
        return CapacityResult(state=CapacityState.UNKNOWN)
    frsize = st.frsize or st.bsize
    return CapacityResult(
        state=CapacityState.QUOTA,
        total=st.blocks * frsize,
        used=(st.blocks - st.bfree) * frsize,
        available=st.bavail * frsize,
        inodes=st.files,
        inodes_used=st.files - st.ffree,
        inodes_free=st.favail,
    )
