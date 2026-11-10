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

from collections.abc import Sequence
from dataclasses import dataclass

from mirage.accessor.sql import SqlAccessor
from mirage.core.sql.constants import (
    INODE_COLUMNS,
    MAX_COLUMNS,
    MAX_PARAMS,
    ROOT_INO,
)
from mirage.core.sql.inode import Inode, InoRef, by_ino, inode_of, is_dir
from mirage.errors.fs import eisdir, enoent, enotdir, listing_error
from mirage.types import PathSpec
from mirage.utils.path import norm


@dataclass(frozen=True)
class Walk:
    """A mount path resolved one name at a time from the mount's
    folder. ``chain[0]`` is the folder and ``chain[i]`` the inode the
    first ``i`` names reach, None from the first name the tree does not
    hold (or that a file stands above), and all None when the folder is
    gone. Mirrors TypeScript's ``Walk``.
    """

    p: str
    names: tuple[str, ...]
    chain: tuple[Inode | None, ...]


def names_of(p: str) -> tuple[str, ...]:
    """The names a normalized mount path walks from the root."""
    bare = p.strip("/")
    return tuple(bare.split("/")) if bare else ()


# SQLite joins at most this many tables in one query.
_MAX_JOIN_TABLES = 64

# One query walks as many names as its limits allow: every inode column
# for the start and each name within ``MAX_COLUMNS``, two tables a name
# past the start within ``_MAX_JOIN_TABLES``, one parameter a name
# within ``MAX_PARAMS``. The columns bind first, at 19 names. A deeper
# path walks on from where the last query stopped.
_NAMES_PER_QUERY = min(
    MAX_COLUMNS // len(INODE_COLUMNS) - 1,
    (_MAX_JOIN_TABLES - 1) // 2,
    MAX_PARAMS,
)


async def _walk_from(
    accessor: SqlAccessor, start: int, names: Sequence[str]
) -> list[Inode | None]:
    """The inode ``start`` and the inode each of ``names`` reaches below
    it in turn, None from the first miss, in one query: each level joins
    the entry under the inode above it."""
    levels = len(names) + 1
    select: list[str] = []
    joins: list[str] = []
    for i in range(levels):
        select += [f"n{i}.{c} AS l{i}_{c}" for c in INODE_COLUMNS]
        if i > 0:
            joins += [
                f"LEFT JOIN fs_dentry d{i} ON d{i}.parent_ino = n{i - 1}.ino"
                f" AND d{i}.name = ?",
                f"LEFT JOIN fs_inode n{i} ON n{i}.ino = d{i}.ino",
            ]
    sql = (
        f"SELECT {', '.join(select)} FROM fs_inode n0 {' '.join(joins)}"
        f"\n    WHERE n0.ino = {by_ino(start).sql}"
    )
    rows = await accessor.query(sql, names)
    row = rows[0] if rows else None
    return [inode_of(row, f"l{i}_") for i in range(levels)]


async def walk(accessor: SqlAccessor, path: PathSpec | str) -> Walk:
    """Resolve ``path`` from the database's root through the mount's
    folder, ``_NAMES_PER_QUERY`` names a query, so the database walks
    every name and answers every inode on the way, and a miss stops the
    chain where it happens. Mirrors TypeScript's ``walk``."""
    p = norm(path if isinstance(path, str) else path.mount_path)
    names = names_of(p)
    every = (*accessor.root_names, *names)
    chain = await _walk_from(accessor, ROOT_INO, every[:_NAMES_PER_QUERY])
    for at in range(_NAMES_PER_QUERY, len(every), _NAMES_PER_QUERY):
        part = every[at : at + _NAMES_PER_QUERY]
        last = chain[-1]
        if last is None:
            chain += [None] * len(part)
        else:
            chain += (await _walk_from(accessor, last.ino, part))[1:]
    return Walk(p, names, tuple(chain[len(accessor.root_names) :]))


def target(w: Walk) -> Inode | None:
    """The inode the whole path reaches, or None."""
    return w.chain[len(w.names)]


def parent_of(w: Walk) -> Inode | None:
    """The directory that holds the path's last name, or None."""
    return w.chain[len(w.names) - 1] if w.names else None


def parent_ref(w: Walk) -> InoRef:
    """The parent as a statement names it; the walk must have found
    it."""
    parent = parent_of(w)
    return by_ino(parent.ino if parent is not None else ROOT_INO)


def leaf(w: Walk) -> str:
    """The path's last name; empty for the root."""
    return w.names[-1] if w.names else ""


def _broken_parent(w: Walk, spec: PathSpec) -> OSError | None:
    # The first error resolving the path's parents meets: a name the
    # tree does not hold is ENOENT, a plain file where a directory has
    # to be ENOTDIR, at any depth, as open(2) and rename(2) resolve a
    # path. The mount's folder gone is ENOENT too.
    for i in range(len(w.names)):
        node = w.chain[i]
        if node is None:
            return enoent(spec)
        if not is_dir(node):
            return enotdir(spec)
    return None


def check_dest_parents(w: Walk, spec: PathSpec) -> None:
    """Refuse a path whose parents are not all directories: every op
    that makes an entry creates none of them, which is ``mkdir -p``'s
    job. Mirrors TypeScript's ``checkDestParents``."""
    broken = _broken_parent(w, spec)
    if broken is not None:
        raise broken


def check_write_target(w: Walk, spec: PathSpec) -> None:
    """Refuse writing bytes to a directory, as open(2) for writing
    does."""
    node = target(w)
    if node is not None and is_dir(node):
        raise eisdir(spec)


def lookup_error(w: Walk, spec: PathSpec) -> OSError:
    """The error a lookup of a path the walk did not reach answers: a
    plain file above it is ENOTDIR (``cat a.txt/x``), anything else
    ENOENT. Mirrors TypeScript's ``lookupError``."""
    return _broken_parent(w, spec) or enoent(spec)


def found(w: Walk, spec: PathSpec) -> Inode:
    """The inode the path names, or the error its lookup answers."""
    node = target(w)
    if node is None:
        raise lookup_error(w, spec)
    return node


async def not_listable(w: Walk, spec: PathSpec) -> OSError:
    """The error listing a path that is no directory answers, off the
    walk."""
    at = {
        "/" + "/".join(w.names[: i + 1]): w.chain[i + 1]
        for i in range(len(w.names))
    }

    async def is_file_at(k: str) -> bool:
        node = at.get(k)
        return node is not None and not is_dir(node)

    async def is_dir_at(k: str) -> bool:
        node = at.get(k)
        return node is not None and is_dir(node)

    return await listing_error(spec, w.p, is_file_at, is_dir_at)
