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

import asyncio
import logging
import os
import shutil
from pathlib import Path

import aiofiles.os

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.errors import disk_error
from mirage.core.disk.utils import resolve_inside
from mirage.errors.posix import errno_of
from mirage.observe.context import record, start_op
from mirage.observe.record import OpStatus
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


Signature = tuple[int, int, int, int]


def _signature(path: Path) -> Signature | None:
    """What is at the destination, None when nothing is.

    Raises OSError when the stat cannot tell, which proves nothing either
    way.

    Args:
        path (Path): the host path.
    """
    try:
        st = os.stat(path)
    except (FileNotFoundError, NotADirectoryError):
        return None
    return (st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)


async def _changed_since(path: Path, before: Signature | None) -> bool:
    """Whether a failed copy may have changed the destination: unless a
    second probe sees it as the first did, it may have.

    Args:
        path (Path): the host path.
        before (Signature | None): what the first probe saw.
    """
    try:
        return await asyncio.to_thread(_signature, path) != before
    except OSError as exc:
        logger.debug("copy destination %s not probed: %s", path, exc)
        return True


async def copy(
    accessor: DiskAccessor, src_spec: PathSpec, dst_spec: PathSpec
) -> None:
    root = accessor.root
    s = await resolve_inside(root, src_spec)
    d = await resolve_inside(root, dst_spec)
    timer = start_op()
    seen = True
    before: Signature | None = None
    try:
        before = await asyncio.to_thread(_signature, d)
    except OSError as exc:
        logger.debug("copy destination %s not probed: %s", d, exc)
        seen = False
    failure: BaseException | None = None
    try:
        await asyncio.to_thread(shutil.copyfile, s, d)
        await asyncio.to_thread(shutil.copystat, s, d)
    except OSError as exc:
        failure = exc
        # copyfile reports ENOENT and EACCES for either operand, so the
        # operand to blame is only knowable after the failure: probe whether
        # the source reads to tell them apart. Either way the host path
        # never reaches the message.
        blame_src = isinstance(
            exc, (FileNotFoundError, PermissionError)
        ) and not await aiofiles.os.access(s, os.R_OK)
        spec = src_spec if blame_src else dst_spec
        raise disk_error(exc, spec.virtual) from exc
    except BaseException as exc:
        failure = exc
        raise
    finally:
        # Also when the copy raised: copyfile that fails part-way has
        # already written the destination, as on the object stores. A
        # cancelled wait leaves its worker running, so only the copy's own
        # error is probed; anything else may still change the destination,
        # and so may a copy either probe could not see. The row is written
        # even when the probe itself is cancelled.
        changed = True
        try:
            if seen and isinstance(failure, OSError):
                changed = await _changed_since(d, before)
        finally:
            record(
                "copy",
                dst_spec.virtual,
                "disk",
                0,
                timer,
                status=OpStatus.OK
                if failure is None
                else OpStatus.PARTIAL
                if changed
                else OpStatus.FAILED,
                errno=errno_of(failure),
                changed=changed,
            )
