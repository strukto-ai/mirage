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

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox._client import DropboxApiError
from mirage.core.dropbox.api import get_metadata
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.types import PathSpec


async def exists(accessor: DropboxAccessor, path: PathSpec) -> bool:
    api_path = dropbox_path_of(accessor, path)
    if api_path == accessor.root_path:
        return True
    try:
        await get_metadata(accessor.token_manager, api_path)
    except DropboxApiError as exc:
        if exc.status == 409:
            return False
        raise
    return True
