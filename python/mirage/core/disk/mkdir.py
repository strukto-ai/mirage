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

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.dest import mkdir_component_error
from mirage.core.disk.errors import disk_error, disk_errors
from mirage.core.disk.utils import resolve_inside_sync
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.path import norm


async def mkdir(
    accessor: DiskAccessor, path_spec: PathSpec, parents: bool = False
) -> None:
    path = path_spec.mount_path
    root = accessor.root
    resolved = False

    def make() -> None:
        nonlocal resolved
        p = resolve_inside_sync(root, path_spec, path)
        resolved = True
        if parents:
            os.makedirs(p, exist_ok=True)
            return
        with disk_errors(path_spec.virtual):
            os.mkdir(p)

    timer = start_op()
    if parents:
        # Not `disk_errors`: that restamps every OSError against the
        # operand, which would undo the component naming below.
        try:
            await asyncio.to_thread(make)
        except NotADirectoryError as exc:
            if not resolved:
                raise
            # The kernel names the whole path; GNU names the component it
            # tripped on, so the chain is walked only now that it is known
            # to be broken. A failure the walk cannot explain keeps the
            # operand, like every other disk error.
            named = await mkdir_component_error(root, path_spec, norm(path))
            raise (named or disk_error(exc, path_spec.virtual)) from exc
        except OSError as exc:
            if not resolved:
                raise
            raise disk_error(exc, path_spec.virtual) from exc
        finally:
            # Also when it raised: the chain may have made its first
            # directories before a later one failed.
            if resolved:
                record("mkdir", path_spec.virtual, "disk", 0, timer)
        return
    # An existing target is EEXIST, not success: only -p is idempotent.
    done = True
    try:
        await asyncio.to_thread(make)
    except Exception:
        done = False
        raise
    finally:
        # A refused mkdir(2) made nothing; a cancelled wait may not have
        # stopped the worker's.
        if done:
            record("mkdir", path_spec.virtual, "disk", 0, timer)
