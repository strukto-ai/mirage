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

import posixpath
from typing import Any

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox.api import lookup
from mirage.errors.fs import enoent
from mirage.types import PathSpec
from mirage.utils.key_prefix import raw_path_of


def dropbox_path_of(accessor: DropboxAccessor, path: PathSpec) -> str:
    """Map a mount path to the Dropbox API path under the configured root.

    Args:
        accessor (DropboxAccessor): carries the normalized root_path.
        path (PathSpec): mount path to translate.
    """
    p = raw_path_of(path)
    key = p.strip("/")
    return accessor.root_path if not key else f"{accessor.root_path}/{key}"


def spelled_otherwise(path: PathSpec, entry: dict[str, Any] | None) -> bool:
    """Whether Dropbox answered for ``path`` with a name in another case.

    Dropbox matches a path case-insensitively, a listing does not: a file
    stored as ``N`` is not ``n``. An answer without a name proves nothing,
    and calling it absent would let a write go out over a file that is
    there.

    Args:
        path (PathSpec): the path asked for.
        entry (dict[str, Any] | None): the metadata Dropbox answered.
    """
    named = None if entry is None else entry.get("name")
    return isinstance(named, str) and named != posixpath.basename(
        path.vfs_path.strip("/")
    )


async def check_path(
    accessor: DropboxAccessor, path: PathSpec
) -> dict[str, Any] | None:
    """Validate each existing component without accepting service case aliases.

    Args:
        accessor (DropboxAccessor): backend and configured root.
        path (PathSpec): operand whose virtual spelling a refusal names.
    """
    key = raw_path_of(path).strip("/")
    at = accessor.root_path
    entry = None
    for part in key.split("/") if key else ():
        at = f"{at}/{part}"
        entry = await lookup(accessor.token_manager, at)
        if entry is None:
            return None
        named = entry.get("name")
        if isinstance(named, str) and named != part:
            raise enoent(path)
    return entry
