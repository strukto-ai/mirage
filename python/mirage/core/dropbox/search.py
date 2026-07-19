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

import logging

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox._client import DropboxApiError
from mirage.core.dropbox.api import search_files
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of
from mirage.utils.path import rebase_raw

logger = logging.getLogger(__name__)


def _path_components(virtual: str) -> list[str]:
    return virtual.split("/")


async def narrow_paths(
    accessor: DropboxAccessor,
    query: str,
    paths: list[PathSpec],
) -> list[PathSpec] | None:
    """Use Dropbox file search to narrow grep/rg scopes to candidate files.

    Search results are compared against each scope on ``path_lower``
    (Dropbox paths are case-insensitive) and mapped back to mount paths
    from ``path_display``. Per-scope results are sorted component-wise so
    they line up with the order a sorted readdir walk would visit, and
    each ``raw_path`` is rebased onto the scope's as-typed spelling so
    output labels match a walk's.

    Returns None whenever the narrowed set cannot be trusted as a superset
    of what a full scan would read (API failure, or the 10,000-match
    search ceiling), so the caller falls back to the full scan.

    Args:
        accessor (DropboxAccessor): backend handle carrying the root path.
        query (str): literal search query.
        paths (list[PathSpec]): scope paths, possibly mount-prefixed.

    Returns:
        list[PathSpec] | None: one PathSpec per matching file under the
            scopes, or None when narrowing is unusable.
    """
    if not paths:
        return []
    mount_prefix = mount_prefix_of(paths[0].virtual, paths[0].resource_path)
    root = accessor.root_path
    narrowed: list[PathSpec] = []
    for p in paths:
        scope_api = dropbox_path_of(accessor, p)
        try:
            results, truncated = await search_files(accessor.token_manager,
                                                    query,
                                                    path=scope_api)
        except DropboxApiError as exc:
            logger.warning(
                "dropbox search push-down failed (%s); "
                "falling back to per-file scan", exc)
            return None
        if truncated:
            return None
        scope_lower = scope_api.lower()
        scope_prefix = scope_lower.rstrip("/") + "/"
        scoped: list[str] = []
        for lower, display in results:
            if lower != scope_lower and not lower.startswith(scope_prefix):
                continue
            key = display[len(root):].strip("/")
            scoped.append(
                f"{mount_prefix}/{key}" if key else mount_prefix or "/")
        scoped.sort(key=_path_components)
        for virtual in scoped:
            narrowed.append(
                PathSpec(virtual=virtual,
                         directory="",
                         resource_path=mount_key(virtual, mount_prefix),
                         resolved=True,
                         raw_path=rebase_raw([virtual], p.virtual,
                                             p.raw_path)[0]))
    return narrowed
