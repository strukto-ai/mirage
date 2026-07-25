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

import time

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.context import invalidate_after_write, invalidate_ancestors
from mirage.core.dropbox._client import DropboxApiError
from mirage.core.dropbox.api import create_folder, get_metadata
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.observe.context import record
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def _metadata_tag(accessor: DropboxAccessor,
                        api_path: str) -> str | None:
    try:
        entry = await get_metadata(accessor.token_manager, api_path)
    except DropboxApiError as exc:
        if exc.status == 409:
            return None
        raise
    return "folder" if entry.get(".tag") == "folder" else "file"


async def mkdir(accessor: DropboxAccessor,
                path: PathSpec,
                parents: bool = False) -> None:
    """create_folder_v2 auto-creates missing parents and rejects existing
    paths, so the GNU semantics (EEXIST without -p on an existing dir,
    ENOENT on a missing parent without -p) live here.

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        path (PathSpec): folder to create.
        parents (bool): mkdir -p semantics.
    """
    api_path = dropbox_path_of(accessor, path)
    # The mount root always exists (the API rejects the empty path).
    if api_path == accessor.root_path:
        if parents:
            return
        raise FileExistsError(path.virtual)
    existing = await _metadata_tag(accessor, api_path)
    if existing is not None:
        if parents and existing == "folder":
            return
        raise FileExistsError(path.virtual)
    if not parents:
        parent = api_path.rsplit("/", 1)[0]
        if (parent != accessor.root_path
                and await _metadata_tag(accessor, parent) != "folder"):
            raise enoent(path.virtual)
    start_ms = int(time.monotonic() * 1000)
    try:
        await create_folder(accessor.token_manager, api_path)
    except DropboxApiError as exc:
        if exc.summary.startswith("path/conflict"):
            raise FileExistsError(path.virtual) from exc
        raise
    record("mkdir", path.virtual, "dropbox", 0, start_ms)
    await invalidate_after_write(path)
    await invalidate_ancestors(path)
