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

from typing import Generic

from mirage.core.slug_tree.types import A, DirRows, LoadRows
from mirage.errors.fs import enoent, enotdir
from mirage.types import DirListing, FileStat, PathSpec


class SlugTree(Generic[A]):
    """A backend's whole document list, served as a directory tree.

    Every listing of the mount comes from one fetch, so a folder's listing
    carries every folder below it as seeds.

    Args:
        load (LoadRows[A]): fetches the documents and lays out each
            folder's rows, keyed by the folder's tree path.
    """

    def __init__(self, load: LoadRows[A]) -> None:
        self.load = load

    async def readdir(
        self, accessor: A, path: PathSpec, entry: FileStat | None = None
    ) -> DirListing:
        """A folder's rows, with every folder below it as seeds.

        Args:
            accessor (A): the mount's accessor.
            path (PathSpec): the folder, or a glob word in it.
            entry (FileStat | None): what is at the folder.
        """
        return listing_at(await self.load(accessor), path)


def tree_key(path: PathSpec) -> str:
    """The tree path of ``path``; a glob word keys the folder it lists.

    Args:
        path (PathSpec): a path on the mount.
    """
    key = (path.dir if path.pattern else path).mount_path.strip("/")
    return "/" + key if key else "/"


def listing_at(rows: DirRows, path: PathSpec) -> DirListing:
    """The listing of the folder at ``path`` out of the whole tree's rows.

    Args:
        rows (DirRows): every folder's rows, keyed by tree path.
        path (PathSpec): the folder, or a glob word in it.

    Raises:
        NotADirectoryError: a file is at the path.
        FileNotFoundError: nothing is.
    """
    key = tree_key(path)
    if key not in rows:
        parent, _, name = key.rpartition("/")
        if any(row.name == name for row in rows.get(parent or "/", [])):
            raise enotdir(path.virtual)
        raise enoent(path.virtual)
    stem = "" if key == "/" else key
    return DirListing(
        entries=list(rows[key]),
        seeds={
            folder[len(stem) + 1 :]: list(children)
            for folder, children in rows.items()
            if folder != key and folder.startswith(stem + "/")
        },
    )
