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
from functools import partial

from mirage.core.object_store.driver import (
    A,
    C,
    ObjectStoreDriver,
    ReaddirFn,
    TreeEntry,
    TreeFn,
)
from mirage.errors.fs import listing_error
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils import key_prefix as kp
from mirage.utils.filetype import content_type_for_path
from mirage.utils.key_prefix import mount_prefix_of

logger = logging.getLogger(__name__)


async def _probe_file(
    driver: ObjectStoreDriver[A, C], conn: C, kpfx: str, key: str
) -> bool:
    return await driver.head(conn, kp.apply(kpfx, key)) is not None


async def _probe_dir(
    driver: ObjectStoreDriver[A, C], conn: C, kpfx: str, key: str
) -> bool:
    return await driver.probe_prefix(conn, kp.apply_dir(kpfx, key))


def make_readdir(driver: ObjectStoreDriver[A, C]) -> ReaddirFn[A]:
    """Build a prefix listing over one driver.

    Args:
        driver (ObjectStoreDriver): the store's native surface.
    """

    async def readdir(accessor: A, path_spec: PathSpec) -> list[FileStat]:
        prefix = mount_prefix_of(path_spec.virtual, path_spec.vfs_path)
        # When called from resolve_glob with a pattern (e.g. *.txt),
        # use path.directory for the listing. Direct callers (ls, ops)
        # pass pattern=None so path.virtual is used.
        path = path_spec.directory if path_spec.pattern else path_spec.virtual
        if prefix and path.startswith(prefix):
            rest = path[len(prefix) :]
            if prefix.endswith("/") or rest == "" or rest.startswith("/"):
                path = rest or "/"
        kpfx = driver.key_prefix_of(accessor)
        pfx = kp.apply_dir(kpfx, path)
        names: list[str] = []
        dir_keys: set[str] = set()
        sizes: dict[str, int | None] = {}
        times: dict[str, str] = {}
        saw_key = False
        async with driver.connect(accessor) as conn:
            async for child in driver.list_children(conn, pfx):
                saw_key = True
                if child.kind == "marker":
                    continue
                key = "/" + kp.strip(kpfx, child.key)
                if child.kind == "d":
                    if key in dir_keys:
                        continue
                    names.append(key)
                    dir_keys.add(key)
                else:
                    names.append(key)
                    sizes[key] = child.size
                    times[key] = child.modified
            if not saw_key and path.strip("/"):
                # An empty directory is a zero-byte marker object keyed at
                # the prefix itself, so a prefix holding no key at all --
                # not even that marker -- is a path the store does not
                # have. Without this, `ls` on a missing path rendered an
                # empty directory and exited 0 where every real filesystem
                # reports ENOENT. The mount root is exempt: it exists
                # because it is mounted.
                raise await listing_error(
                    path_spec,
                    path,
                    partial(_probe_file, driver, conn, kpfx),
                    partial(_probe_dir, driver, conn, kpfx),
                )
        names = sorted(set(names))
        if len(names) > driver.scope_error:
            logger.warning(
                "%s readdir: %s returned %d entries (limit %d)",
                driver.vfs,
                path_spec.virtual,
                len(names),
                driver.scope_error,
            )
        rows = []
        for key in names:
            name = key.rsplit("/", 1)[-1]
            if key in dir_keys:
                # Store "folders" are synthetic prefixes with no object of
                # their own, so there is no mtime or size to record. A
                # name that is a key and a prefix both lists as the
                # directory, as a walk enters it.
                rows.append(FileStat(name=name, type=FileType.DIRECTORY))
            else:
                rows.append(
                    FileStat(
                        name=name,
                        size=sizes.get(key),
                        modified=times.get(key) or None,
                        type=FileType.FILE,
                        content=content_type_for_path(name),
                    )
                )
        return rows

    return readdir


async def read_tree(
    driver: ObjectStoreDriver[A, C], accessor: A, path: PathSpec
) -> list[TreeEntry]:
    """Every key at and under a path, in one recursive listing.

    The rows are the key at the path itself and every key under it, as
    ``list_subtree`` gives them, markers included.

    Args:
        driver (ObjectStoreDriver): backend primitives.
        accessor (Accessor): backend connection configuration.
        path (PathSpec): operand root.
    """
    kpfx = driver.key_prefix_of(accessor)
    stem = kp.apply(kpfx, path.mount_path).rstrip("/")
    async with driver.connect(accessor) as conn:
        return [entry async for entry in driver.list_subtree(conn, stem)]


def make_tree(driver: ObjectStoreDriver[A, C]) -> TreeFn[A]:
    """Build ``read_tree`` over one driver: one recursive listing.

    Args:
        driver (ObjectStoreDriver): the store's native surface.
    """

    async def tree(accessor: A, path: PathSpec) -> dict[str, FileStat] | None:
        """Every key under ``path`` as the walk's readdir and stat see it,
        and the directory itself under ``""``.

        A file stats as a listing gives it (its size, time and content
        type); a directory, a marker or a key prefix
        alike, carries nothing but its name. A marker for ``path``
        itself names no entry. None, so the walk's readdir and stat
        answer instead, when nothing is under the prefix, when a row has
        no size, when a key has an empty segment, and when one name is
        both a file and a prefix, which a readdir lists as a directory.

        Args:
            accessor (Accessor): backend accessor.
            path (PathSpec): the directory.
        """
        rows = await read_tree(driver, accessor, path)
        kpfx = driver.key_prefix_of(accessor)
        prefix = kp.apply_dir(kpfx, path.mount_path)
        if not any(row.key.startswith(prefix) for row in rows):
            return None
        found: dict[str, FileStat] = {}
        dirs: set[str] = set()
        for row in rows:
            if not row.key.startswith(prefix):
                continue
            rel = row.key[len(prefix) :]
            is_dir = rel.endswith("/")
            rel = rel.rstrip("/")
            if not rel:
                continue
            parts = rel.split("/")
            if "" in parts or (not is_dir and row.size is None):
                return None
            dirs.update(
                "/".join(parts[:depth]) for depth in range(1, len(parts))
            )
            if is_dir:
                dirs.add(rel)
                continue
            found[rel] = FileStat(
                name=parts[-1],
                size=row.size,
                modified=row.modified or None,
                type=FileType.FILE,
                content=content_type_for_path(parts[-1]),
            )
        if not dirs.isdisjoint(found):
            return None
        for rel in dirs:
            found[rel] = FileStat(
                name=rel.rsplit("/", 1)[-1], type=FileType.DIRECTORY
            )
        found[""] = FileStat(
            name=path.mount_path.rstrip("/").rsplit("/", 1)[-1] or "/",
            type=FileType.DIRECTORY,
        )
        return found

    return tree
