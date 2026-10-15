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

from mirage.core.slug_tree.rows import folder_row
from mirage.errors.fs import enoent
from mirage.types import FileStat, PathSpec


def tree_stat(path: PathSpec, entry: FileStat | None) -> FileStat:
    """Stat a path of the tree: the root, or the row its folder names.

    Args:
        path (PathSpec): the path.
        entry (FileStat | None): what is at the path.

    Raises:
        FileNotFoundError: nothing is there.
    """
    if not path.mount_path.strip("/"):
        return folder_row("/")
    if entry is None:
        raise enoent(path.virtual)
    return entry
