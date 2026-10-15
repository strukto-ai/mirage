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

from collections.abc import Callable
from typing import TypeVar

from mirage.core.slug_tree.types import DirRows
from mirage.types import FileStat, FileType
from mirage.utils.path import gnu_basename, parent

V = TypeVar("V")


def normalize_slug(value: str, noun: str) -> str:
    """Turn a backend slug into an absolute tree path.

    Args:
        value (str): the slug as the backend stores it.
        noun (str): what the backend calls a slug, for the error wording.
    """
    parts = [part for part in value.strip("/").split("/") if part]
    if not parts:
        raise ValueError(f"Invalid empty {noun}")
    for part in parts:
        if part in (".", ".."):
            raise ValueError(f"Invalid {noun} segment: {part!r}")
    return "/" + "/".join(parts)


def drop_collisions(
    files: dict[str, V], on_collision: Callable[[str, str], None]
) -> dict[str, V]:
    """Drop every file that another file needs as its directory.

    A backend that refuses such a tree raises from ``on_collision``.

    Args:
        files (dict[str, V]): tree path to the backend's document.
        on_collision (Callable[[str, str], None]): told ``(ancestor,
            path)`` for each path dropped, ``ancestor`` being the file.
    """
    kept = dict(files)
    for path in sorted(files):
        parts = path.strip("/").split("/")
        for depth in range(1, len(parts)):
            ancestor = "/" + "/".join(parts[:depth])
            if ancestor in files:
                on_collision(ancestor, path)
                del kept[path]
                break
    return kept


def dir_rows(
    files: dict[str, V],
    file_row: Callable[[str, V], FileStat],
) -> DirRows:
    """Lay files out as each folder's rows, keyed by the folder's tree path.

    Args:
        files (dict[str, V]): tree path to the backend's document.
        file_row (Callable[[str, V], FileStat]): the backend's row for one
            file.
    """
    directories = {"/"}
    for path in files:
        parts = path.strip("/").split("/")
        for depth in range(1, len(parts)):
            directories.add("/" + "/".join(parts[:depth]))
    rows: DirRows = {directory: [] for directory in directories}
    for directory in sorted(directories - {"/"}):
        rows[parent(directory)].append(folder_row(gnu_basename(directory)))
    for path in sorted(files):
        rows[parent(path)].append(file_row(path, files[path]))
    for children in rows.values():
        children.sort(key=lambda row: row.name)
    return rows


def folder_row(name: str) -> FileStat:
    """A folder of the tree, which exists only as its listing.

    Args:
        name (str): the folder's name.
    """
    return FileStat(
        name=name, type=FileType.DIRECTORY, extra={"children_count": 0}
    )
