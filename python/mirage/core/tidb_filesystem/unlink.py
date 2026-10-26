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

from mirage.accessor.tidb_filesystem import TiDBFilesystemAccessor
from mirage.core.tidb_filesystem.client import remove
from mirage.core.tidb_filesystem.dest import kinds_of, lookup_error
from mirage.core.tidb_filesystem.errors import has_status
from mirage.core.tidb_filesystem.path import backend_path
from mirage.errors.fs import eisdir
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.path import ancestors, norm


async def unlink(accessor: TiDBFilesystemAccessor, path: PathSpec) -> None:
    timer = start_op()
    try:
        await remove(accessor, backend_path(accessor.config, path), "file")
    except Exception as exc:
        if not has_status(exc, 404):
            raise
        key = norm(path.mount_path)
        kinds = await kinds_of(accessor, [*ancestors(key), key])
        found = kinds.get(key)
        if found is not None and found.is_dir:
            raise eisdir(path) from exc
        raise lookup_error(kinds, path, key) from exc
    record("unlink", path.virtual, "tidb_filesystem", 0, timer)
