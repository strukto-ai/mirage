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

from mirage.core.github.tree_entry import TreeEntry
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


def scope_relative_key(path: PathSpec) -> str:
    """Strip the mount prefix from a path to get its repo-relative key.

    Args:
        path (PathSpec): Scope path, possibly mount-prefixed.

    Returns:
        str: Repo-relative key with a leading slash; ``/`` for the root.
    """
    prefix = mount_prefix_of(path.virtual, path.vfs_path)
    key = path.virtual
    if prefix and key.startswith(prefix):
        key = key[len(prefix):] or "/"
    return key


def is_repo_root(key: str) -> bool:
    """Return whether a repo-relative key points at the repository root.

    Args:
        key (str): Repo-relative key from :func:`scope_relative_key`.

    Returns:
        bool: True for ``""`` or ``"/"``.
    """
    return key in ("", "/")


def count_scope_files(tree: dict[str, TreeEntry], key: str) -> int:
    """Count files under a repo-relative scope key.

    Counted off the git tree rather than the index, mirroring
    TypeScript's: the tree keys are repo-relative with no leading slash,
    which is the space ``key`` is already in.

    Args:
        tree (dict[str, TreeEntry]): The recursive git tree.
        key (str): Repo-relative scope key from :func:`scope_relative_key`.

    Returns:
        int: Number of file entries at or below the scope.
    """
    if is_repo_root(key):
        return sum(1 for e in tree.values() if e.type == "blob")
    norm = key.strip("/")
    prefix = norm + "/"
    return sum(1 for p, e in tree.items()
               if e.type == "blob" and (p == norm or p.startswith(prefix)))


def should_use_search(
    recursive: bool,
    on_default_branch: bool,
) -> bool:
    """Whether grep/rg should narrow paths via GitHub code search.

    Search only helps recursive scans on the default branch (code search only
    indexes the default branch). Whether a usable literal exists, and whether
    the scope is large enough to bother, is decided by the caller.
    """
    return recursive and on_default_branch
