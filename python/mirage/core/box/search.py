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
from typing import Any

from mirage.accessor.box import BoxAccessor
from mirage.core.box._client import BoxApiError
from mirage.core.box.api import search_content
from mirage.core.box.resolve import path_parts, resolve_item, root_id
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of
from mirage.utils.path import rebase_raw

logger = logging.getLogger(__name__)


def _path_components(virtual: str) -> list[str]:
    return virtual.split("/")


def _mount_relative_key(item: dict[str, Any],
                        root_folder_id: str) -> str | None:
    # Reconstruct the mount-relative key from the item's ancestor chain by
    # trimming everything up to and including the mount root folder. Box's
    # path_collection lists ancestors from the account root down to the
    # immediate parent (excluding the item itself).
    entries = (item.get("path_collection") or {}).get("entries") or []
    names: list[str] = []
    collecting = False
    for anc in entries:
        if collecting:
            names.append(anc.get("name", ""))
        if anc.get("id") == root_folder_id:
            collecting = True
    if not collecting:
        return None
    names.append(item.get("name", ""))
    return "/".join(n for n in names if n)


async def narrow_paths(
    accessor: BoxAccessor,
    query: str,
    paths: list[PathSpec],
) -> list[PathSpec] | None:
    """Use Box content search to narrow grep/rg scopes to candidate files.

    Each scope is resolved to its Box folder id and searched with that id as
    the `ancestor_folder_ids` scope; hits are mapped back to mount paths from
    their `path_collection` ancestor chain, sorted component-wise so they line
    up with a sorted readdir walk, and each `raw_path` is rebased onto the
    scope's as-typed spelling so output labels match a walk's.

    Returns None whenever the narrowed set cannot be trusted as a superset of
    what a full scan would read (API failure, the 10,000-match ceiling, or a
    scope that no longer resolves to a folder), so the caller falls back to
    the full scan.

    Args:
        accessor (BoxAccessor): backend handle.
        query (str): literal search query.
        paths (list[PathSpec]): scope paths, possibly mount-prefixed.

    Returns:
        list[PathSpec] | None: one PathSpec per matching file under the
            scopes, or None when narrowing is unusable.
    """
    if not paths:
        return []
    mount_prefix = mount_prefix_of(paths[0].virtual, paths[0].resource_path)
    root = root_id(accessor)
    narrowed: list[PathSpec] = []
    for p in paths:
        parts = path_parts(p)
        if parts:
            item = await resolve_item(accessor, parts)
            if item is None or item.get("type") != "folder":
                return None
            folder_id = item["id"]
        else:
            folder_id = root
        try:
            results, truncated = await search_content(accessor.token_manager,
                                                      query, folder_id)
        except BoxApiError as exc:
            logger.warning(
                "box search push-down failed (%s); "
                "falling back to per-file scan", exc)
            return None
        if truncated:
            return None
        scoped: list[str] = []
        for item in results:
            key = _mount_relative_key(item, root)
            if key is None:
                continue
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
