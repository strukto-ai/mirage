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
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


def dropbox_path_of(accessor: DropboxAccessor, path: PathSpec) -> str:
    """Map a mount path to the Dropbox API path under the configured root.

    Args:
        accessor (DropboxAccessor): carries the normalized root_path.
        path (PathSpec): mount path to translate.
    """
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    p = path.virtual
    if prefix and p.startswith(prefix):
        p = p[len(prefix):] or "/"
    key = p.strip("/")
    return accessor.root_path if not key else f"{accessor.root_path}/{key}"
