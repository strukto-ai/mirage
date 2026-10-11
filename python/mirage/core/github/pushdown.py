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

import re

from mirage.core.github.constants import CODE_SEARCH_SIZE_LIMIT
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
        key = key[len(prefix) :] or "/"
    return key


def scope_blobs(
    tree: dict[str, TreeEntry], key: str
) -> list[tuple[str, TreeEntry]]:
    """The file entries at or below a repo-relative scope key.

    Read off the git tree rather than the index, mirroring TypeScript's:
    the tree keys are repo-relative with no leading slash, which is the
    space ``key`` is already in. A sibling that merely shares the scope's
    spelling (``srcx/`` beside ``src/``) is outside it.

    Args:
        tree (dict[str, TreeEntry]): The recursive git tree.
        key (str): Repo-relative scope key from :func:`scope_relative_key`.

    Returns:
        list[tuple[str, TreeEntry]]: each blob's key and entry, in tree
            order; every blob for the repository root.
    """
    norm = key.strip("/")
    prefix = norm + "/"
    return [
        (p, e)
        for p, e in tree.items()
        if e.type == "blob" and (not norm or p == norm or p.startswith(prefix))
    ]


def count_scope_files(tree: dict[str, TreeEntry], key: str) -> int:
    """Count files under a repo-relative scope key.

    Args:
        tree (dict[str, TreeEntry]): The recursive git tree.
        key (str): Repo-relative scope key from :func:`scope_relative_key`.

    Returns:
        int: Number of file entries at or below the scope.
    """
    return len(scope_blobs(tree, key))


_NARROWING = re.compile(
    r'[:"]|(?:^|[^A-Za-z0-9_])-'
    r"|(?:^|[^A-Za-z0-9_])NOT(?:[^A-Za-z0-9_]|$)"
)
_WORD = re.compile(r"[A-Za-z0-9_]")


def search_safe(query: str) -> bool:
    """Whether a literal can be sent to code search without rescoping it.

    The literal goes into the query verbatim, so any part of it the search
    grammar reads as syntax narrows the answer to less than the files that
    hold it. Measured against api.github.com: a ``name:`` word is a
    qualifier, a quote opens a phrase, a word-leading ``-`` negates and
    ``NOT`` is an operator; lowercase ``not`` and ``OR`` are plain terms, and
    parentheses are refused with a 422, which already falls back. Word
    characters are ASCII so both hosts gate the same literals, and a literal
    holding none of them would send a query that is only its scope.

    Args:
        query (str): the literal grep would push down.

    Returns:
        bool: True when the search answers for exactly this literal.
    """
    return bool(_WORD.search(query)) and not _NARROWING.search(query)


def unsearchable_keys(tree: dict[str, TreeEntry], key: str) -> list[str]:
    """List the files under a scope that code search never indexes.

    A file at or over ``CODE_SEARCH_SIZE_LIMIT`` is not indexed, so no
    search can name it; a size the tree did not report is counted with them,
    since nothing vouches for it either.

    Args:
        tree (dict[str, TreeEntry]): The recursive git tree.
        key (str): Repo-relative scope key from :func:`scope_relative_key`.

    Returns:
        list[str]: Sorted repo-relative keys of those files.
    """
    return sorted(
        p
        for p, e in scope_blobs(tree, key)
        if e.size is None or e.size >= CODE_SEARCH_SIZE_LIMIT
    )
