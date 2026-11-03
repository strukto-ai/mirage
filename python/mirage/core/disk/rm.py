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
import os
import stat

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.utils import resolve_inside
from mirage.errors.posix import errno_of
from mirage.observe.context import record, start_op
from mirage.observe.record import OpStatus
from mirage.types import PathSpec



async def rm_r(accessor: DiskAccessor, path_spec: PathSpec) -> None:
    p = os.fspath(await resolve_inside(accessor.root, path_spec))
    timer = start_op()
    failure: BaseException | None = None
    removed = False
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

    def empty(fd: int) -> None:
        # By directory descriptor, as rmtree walks: a directory swapped for
        # a link mid-walk is refused, never followed. Files go before the
        # walk descends, as rmtree orders them.
        nonlocal removed
        with os.scandir(fd) as entries:
            children = [(e.name, e.is_dir(follow_symlinks=False)) for e in entries]
        for name in (name for name, is_dir in children if not is_dir):
            os.unlink(name, dir_fd=fd)
            removed = True
        for name in (name for name, is_dir in children if is_dir):
            child = os.open(name, flags, dir_fd=fd)
            try:
                empty(child)
            finally:
                os.close(child)
            os.rmdir(name, dir_fd=fd)
            removed = True

    def remove() -> None:
        nonlocal removed
        try:
            mode = os.lstat(p).st_mode
        except FileNotFoundError:
            return
        if stat.S_ISDIR(mode):
            top = os.open(p, flags)
            try:
                empty(top)
            finally:
                os.close(top)
            os.rmdir(p)
        else:
            os.unlink(p)
        removed = True

    try:
        await asyncio.to_thread(remove)
    except BaseException as exc:
        failure = exc
        raise
    finally:
        # Also when the walk raised: one that fails part-way has already
        # removed entries, as on the object stores. A cancelled wait
        # leaves its worker running, so it may still remove some.
        changed = (
            failure is None or removed or not isinstance(failure, OSError)
        )
        record(
            "rm_r",
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
