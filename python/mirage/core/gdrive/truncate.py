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
from mirage.core.gdrive.resolve import eacces_on_denied, resolve_key
from mirage.core.gdrive.write import write_bytes
from mirage.core.google.drive import download_file
from mirage.types import PathSpec
from mirage.utils.errors import eisdir


@eacces_on_denied
async def truncate(accessor: GDriveAccessor, path: PathSpec,
                   length: int) -> None:
    node = await resolve_key(accessor, path.resource_path)
    if node is not None and node.is_folder:
        raise eisdir(path.virtual)
    if node is None or node.is_native:
        data = b""
    else:
        data = await download_file(accessor.token_manager, node.id)
    if length <= len(data):
        new = data[:length]
    else:
        new = data + b"\x00" * (length - len(data))
    await write_bytes(accessor, path, new)
