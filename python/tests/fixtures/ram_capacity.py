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

from mirage.accessor.ram import RAMAccessor
from mirage.types import PathSpec
from mirage.vfs.capacity import StorageUsage
from mirage.vfs.ram import RAMVFS


def capped(
    cap: int, files: dict[str, bytes] | None = None
) -> tuple[RAMAccessor, StorageUsage]:
    """A RAM accessor whose store holds at most ``cap`` bytes.

    Args:
        cap (int): the cap in bytes.
        files (dict[str, bytes] | None): the table's starting files.
    """
    vfs = RAMVFS(capacity=cap)
    for key, data in (files or {}).items():
        vfs.accessor.store.files[key] = data
    assert vfs.usage is not None
    return vfs.accessor, vfs.usage


def table_bytes(accessor: RAMAccessor) -> int:
    """The bytes the accessor's table holds.

    Args:
        accessor (RAMAccessor): the RAM accessor.
    """
    files = accessor.store.files
    return sum(len(files[key]) for key in files)


def ram_path(path: str) -> PathSpec:
    """A RAM-relative spec for ``path``.

    Args:
        path (str): the mount path, with its leading slash.
    """
    return PathSpec(vfs_path=path.lstrip("/"), virtual=path, directory=path)
