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

from mirage.context import DEFAULT_UMASK
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec
from mirage.utils.errors import FS_ERRORS
from mirage.workspace.session import SessionState

logger = logging.getLogger(__name__)


async def create_file(dispatch: DispatchFn, session: SessionState,
                      scope: PathSpec, data: bytes) -> None:
    """Write a file, giving it the umask's mode if the write created it.

    Every shell path that opens a file for writing goes through here, so
    `echo x > f` and `exec > f` agree about the mode a fresh file gets:
    0666 masked by the session's umask, which is what `open(2)` with
    `O_CREAT` does. Living in one place is the point; the two callers
    had drifted while it was private to one of them.

    The existence probe runs only under a non-default umask, because
    that is the one case the answer changes anything: a fresh file
    already renders as 644, which is 0666 under bash's default mask. A
    mode that cannot be written is logged and not fatal, since the bytes
    are already there and the write is what the caller asked for.

    Args:
        dispatch (DispatchFn): op dispatcher.
        session (SessionState): the session holding the umask.
        scope (PathSpec): the target.
        data (bytes): the bytes to write.
    """
    created = False
    if session.umask != DEFAULT_UMASK:
        try:
            await dispatch("stat", scope)
        except FS_ERRORS as exc:
            logger.debug("write target %s is new: %s", scope.raw_path, exc)
            created = True
    await dispatch("write", scope, data=data)
    if not created:
        return
    try:
        await dispatch("setattr",
                       scope,
                       mode=0o666 & ~session.umask,
                       uid=None,
                       gid=None,
                       atime=None,
                       mtime=None)
    except FS_ERRORS as exc:
        logger.debug("umask mode write failed for %s: %s", scope.raw_path, exc)
