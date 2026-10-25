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

from mirage.core.slug_tree.tree import SlugTree, listing_at, tree_key
from mirage.core.slug_tree.types import A
from mirage.errors.fs import enoent
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.glob_walk import resolve_glob_with
from mirage.utils.key_prefix import mount_prefix_of


def validate_query(query: str, top_k: int) -> None:
    if not query:
        raise ValueError("query is required")
    if len(query) > 250:
        raise ValueError("query cannot exceed 250 characters")
    if top_k <= 0:
        raise ValueError("top-k must be positive")


async def target_entries(
    tree: SlugTree[A],
    accessor: A,
    paths: list[PathSpec],
) -> dict[str, FileStat]:
    """Every file a search scope covers, keyed by its slug.

    Args:
        tree (SlugTree[A]): the backend's tree.
        accessor (A): the mount's accessor.
        paths (list[PathSpec]): files and folders to search.

    Raises:
        FileNotFoundError: a scope names nothing in the tree.
    """
    rows = await tree.load(accessor)
    targets: dict[str, FileStat] = {}
    for path in paths:
        key = tree_key(path)
        if key in rows:
            stem = "" if key == "/" else key
            for folder, children in rows.items():
                if folder != key and not folder.startswith(stem + "/"):
                    continue
                for row in children:
                    if row.type is not FileType.DIRECTORY:
                        slug = f"{folder.rstrip('/')}/{row.name}".strip("/")
                        targets[slug] = row
            continue
        parent, _, name = key.rpartition("/")
        found = next(
            (row for row in rows.get(parent or "/", []) if row.name == name),
            None,
        )
        if found is None:
            raise enoent(path.virtual)
        targets[key.strip("/")] = found
    return targets


async def search_scope(
    tree: SlugTree[A],
    accessor: A,
    paths: list[PathSpec],
) -> tuple[list[PathSpec], str]:
    """The paths a batch search covers and the prefix its hits print under.

    A scope at the mount root covers the whole collection, which the
    backend searches unfiltered, so it resolves to no paths at all. Globs
    expand against one load of the tree.

    Args:
        tree (SlugTree[A]): the backend's tree.
        accessor (A): the mount's accessor.
        paths (list[PathSpec]): the search scopes, globs unexpanded.
    """
    if not paths:
        raise ValueError("at least one scope is required")
    prefix = mount_prefix_of(paths[0].virtual, paths[0].vfs_path)
    if any(not path.vfs_path.strip("/") for path in paths):
        return [], prefix
    rows = await tree.load(accessor)

    async def listed(path: PathSpec) -> list[str]:
        base = path.virtual.rstrip("/")
        return [f"{base}/{row.name}" for row in listing_at(rows, path).entries]

    return await resolve_glob_with(listed, paths), prefix
