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

from pathlib import Path

import aiofiles.os

from mirage.accessor.disk import DiskAccessor
from mirage.cache.context import invalidate_after_write, invalidate_ancestors
from mirage.core.disk.dest import mkdir_component_error
from mirage.core.disk.errors import disk_error, disk_errors
from mirage.types import PathSpec
from mirage.utils.path import norm


def _resolve(root: Path, path: str) -> Path:
    relative = path.lstrip("/")
    resolved = (root / relative).resolve()
    resolved.relative_to(root)
    return resolved


async def mkdir(accessor: DiskAccessor,
                path_spec: PathSpec,
                parents: bool = False) -> None:
    path = path_spec.mount_path
    root = accessor.root
    p = _resolve(root, path)
    if parents:
        # Not `disk_errors`: that restamps every OSError against the
        # operand, which would undo the component naming below.
        try:
            await aiofiles.os.makedirs(p, exist_ok=True)
        except NotADirectoryError as exc:
            # The kernel names the whole path; GNU names the component it
            # tripped on, so the chain is walked only now that it is known
            # to be broken. A failure the walk cannot explain keeps the
            # operand, like every other disk error.
            named = await mkdir_component_error(root, path_spec, norm(path))
            raise (named or disk_error(exc, path_spec.virtual)) from exc
        except OSError as exc:
            raise disk_error(exc, path_spec.virtual) from exc
        await invalidate_after_write(path_spec)
        await invalidate_ancestors(path_spec)
        return
    # An existing target is EEXIST, not success: only -p is idempotent.
    with disk_errors(path_spec.virtual):
        await aiofiles.os.mkdir(p)
    await invalidate_after_write(path_spec)
