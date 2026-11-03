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
from pathlib import Path

import aiofiles.os

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.dest import mkdir_component_error
from mirage.core.disk.errors import disk_error, disk_errors
from mirage.core.disk.utils import resolve_inside
from mirage.errors.posix import errno_of
from mirage.observe.context import record, start_op
from mirage.observe.record import OpStatus
from mirage.types import PathSpec
from mirage.utils.path import norm

logger = logging.getLogger(__name__)


def _first_missing(path: Path) -> Path | None:
    """The topmost missing directory of the chain, None when it all exists.

    Raises OSError when an lstat cannot tell, which proves nothing either
    way.

    Args:
        path (Path): the host path of the chain's last directory.
    """
    missing = None
    while True:
        try:
            os.lstat(path)
            return missing
        except (FileNotFoundError, NotADirectoryError):
            missing = path
        if path.parent == path:
            return missing
        path = path.parent


async def _changed_since(path: Path, missing: Path | None) -> bool:
    """Whether a failed ``mkdir -p`` may have made part of the chain:
    unless a second probe finds it as the first did, it may have.

    Args:
        path (Path): the host path of the chain's last directory.
        missing (Path | None): what the first probe found missing.
    """
    try:
        return await asyncio.to_thread(_first_missing, path) != missing
    except OSError as exc:
        logger.debug("mkdir -p chain %s not probed: %s", path, exc)
        return True


async def mkdir(
    accessor: DiskAccessor, path_spec: PathSpec, parents: bool = False
) -> None:
    path = path_spec.mount_path
    root = accessor.root
    p = await resolve_inside(root, path_spec, path)
    timer = start_op()
    if parents:
        # Not `disk_errors`: that restamps every OSError against the
        # operand, which would undo the component naming below.
        seen = True
        missing: Path | None = None
        try:
            missing = await asyncio.to_thread(_first_missing, p)
        except OSError as exc:
            logger.debug("mkdir -p chain %s not probed: %s", p, exc)
            seen = False
        failure: BaseException | None = None
        try:
            await aiofiles.os.makedirs(p, exist_ok=True)
        except NotADirectoryError as exc:
            failure = exc
            # The kernel names the whole path; GNU names the component it
            # tripped on, so the chain is walked only now that it is known
            # to be broken. A failure the walk cannot explain keeps the
            # operand, like every other disk error.
            named = await mkdir_component_error(root, path_spec, norm(path))
            raise (named or disk_error(exc, path_spec.virtual)) from exc
        except OSError as exc:
            failure = exc
            raise disk_error(exc, path_spec.virtual) from exc
        except BaseException as exc:
            failure = exc
            raise
        finally:
            # Also when it raised: the chain may have made its first
            # directories before a later one failed. A cancelled wait
            # leaves its worker running, so only makedirs' own error is
            # probed; anything else may still make the chain, and so may a
            # chain either probe could not see. The row is written even
            # when the probe itself is cancelled.
            changed = True
            try:
                if seen and isinstance(failure, OSError):
                    changed = await _changed_since(p, missing)
            finally:
                record(
                    "mkdir",
                    path_spec.virtual,
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
        return
    # An existing target is EEXIST, not success: only -p is idempotent.
    done = True
    try:
        with disk_errors(path_spec.virtual):
            await aiofiles.os.mkdir(p)
    except OSError:
        done = False
        raise
    finally:
        # A refused mkdir(2) made nothing; a cancelled wait may not have
        # stopped the worker's.
        if done:
            record("mkdir", path_spec.virtual, "disk", 0, timer)
