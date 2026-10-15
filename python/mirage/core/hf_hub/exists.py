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

from mirage.accessor.hf_hub import HfHubAccessor
from mirage.types import FileStat, PathSpec


async def exists(
    accessor: HfHubAccessor,
    path: PathSpec,
    entry: FileStat | None = None,
) -> bool:
    """Whether anything exists at a path: the mount root, or a path its
    folder's listing names.

    Args:
        accessor (HfHubAccessor): backend handle.
        path (PathSpec): the path to probe.
        entry (FileStat | None): the path's row.

    Returns:
        bool: True for a file or a directory, False for an absence.
    """
    return not path.mount_path.strip("/") or entry is not None
