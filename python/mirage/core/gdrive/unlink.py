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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.context import invalidate_after_unlink
from mirage.core.gdrive.resolve import eacces_on_denied, resolve_key
from mirage.core.google.drive import delete_file
from mirage.types import PathSpec
from mirage.utils.errors import eisdir, enoent


@eacces_on_denied
async def unlink(accessor: GDriveAccessor, path: PathSpec) -> None:
    virtual = path.virtual
    key = path.resource_path
    if not key:
        raise eisdir(virtual)
    node = await resolve_key(accessor, key)
    if node is None:
        raise enoent(virtual)
    if node.is_folder:
        raise eisdir(virtual)
    await delete_file(accessor.token_manager, node.id)
    await invalidate_after_unlink(path)
