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

from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import replace
from typing import Any, Literal, TypeVar

from mirage.core.hierarchy.probe import A, ReaddirFn
from mirage.core.hierarchy.scope import INVALID, ROOT, DetectFn, ScopeMatch
from mirage.errors.fs import enoent, enotdir
from mirage.io.stream import close_quietly
from mirage.types import ContentType, DirListing, FileStat, FileType, PathSpec

T = TypeVar("T")

Listed = list[FileStat] | DirListing
Lister = Callable[[A, ScopeMatch], Awaitable["Listed | None"]]
EntryLister = Callable[[A, ScopeMatch, FileStat], Awaitable[Listed]]
Guard = Callable[[A, ScopeMatch, str], Awaitable[None]]
PatternTest = Callable[[str], bool]
ExtraFn = Callable[[ScopeMatch], dict[str, str]]


async def held_pages(
    pages: AsyncIterator[list[T]], limit: int | None
) -> list[T]:
    """What a paged listing's pages hold, and no page past the one that
    brings ``limit`` rows; the pages are closed there.

    Args:
        pages (AsyncIterator[list[T]]): the listing's pages, in order.
        limit (int | None): the most rows a walk can still keep.
    """
    held: list[T] = []
    try:
        async for page in pages:
            held.extend(page)
            if limit is not None and len(held) >= limit:
                break
    finally:
        await close_quietly(pages)
    return held


def cut_listing(rows: list[FileStat], limit: int | None) -> Listed:
    """A paged listing's rows, partial once they reach a walk's ``limit``:
    its lister stopped paging there, so a row past them may exist.

    Args:
        rows (list[FileStat]): the rows the pages held.
        limit (int | None): the most entries the walk can still keep.
    """
    if limit is not None and len(rows) >= limit:
        return DirListing(rows, partial=True)
    return rows


def make_readdir(
    detect: DetectFn,
    *,
    listers: Mapping[str, Lister[A]],
    entry_listers: Mapping[str, EntryLister[A]] | None = None,
    parent_entry_listers: Mapping[str, EntryLister[A]] | None = None,
    static_root: tuple[str, ...] | None = None,
    guards: Mapping[str, Guard[A]] | None = None,
    pattern_kinds: Mapping[str, PatternTest] | None = None,
    leaf_error: Literal["enoent", "enotdir"] = "enoent",
    extras: Mapping[str, ExtraFn] | None = None,
) -> ReaddirFn[A]:
    """Build a hierarchy readdir: dispatch, guards, rows as stat answers.

    A lister fetches one directory kind and answers its children's
    stats; classification, existence guards and the shape a kind shares
    happen here, identically for every backend. Each listed row is
    finished from its own kind: ``extras`` add the slots it was addressed
    by, and a leaf the lister left untyped renders as its scope's
    filetype (JSON by default), so a listed row is what ``stat`` answers.
    A dot-prefixed name is dropped from the listing: the classifier
    refuses every dot-leading segment, so listing one would advertise a
    path that stat, read and child readdir all report absent.
    A lister may answer None instead of a listing: the directory's
    container does not exist, reported as ENOENT on the virtual path.
    A lister may answer a ``DirListing`` to seed descendant listings its
    fetch already proved, or to mark a view or a window. A walk's
    ``limit`` reaches every lister in ``ScopeMatch.limit``.

    An entry lister is for a directory whose existence and contents are
    already proven by its parent's listing: it is handed the row that
    listing named (``entry``), so entering a directory a traversal just
    listed costs no call beyond its own listing. The facts a child
    listing needs beyond the API's own answers ride that row's ``extra``
    (trello stashes each ``card.json`` size on the card's row).

    A parent-entry lister is for a directory whose existence is decided
    by its PARENT's row rather than its own: a dated-message day dir is
    real for any well-formed date under a channel that exists, including
    dates the channel's bounded listing window never minted, so the proof
    is the channel's row (``parent``) and the fetch takes the date from
    the match.

    Args:
        detect (DetectFn): the backend's scope classifier.
        listers (Mapping[str, Lister]): one lister per directory kind;
            include ``root`` for a dynamic mount root.
        entry_listers (Mapping[str, EntryLister]): listers handed the
            directory's own row.
        parent_entry_listers (Mapping[str, EntryLister]): listers handed
            the parent directory's row instead of their own; a kind
            appears in at most one of the three tables.
        static_root (tuple[str, ...] | None): fixed top-level names, for
            backends whose root never changes.
        guards (Mapping[str, Guard]): existence checks that run before
            the listing, so a vanished container is ENOENT.
        pattern_kinds (Mapping[str, PatternTest] | None): one entry per
            kind whose listing is a bounded window, holding the test for
            whether a glob is one its lister can move the window to
            (``has_glob_span`` for a date-keyed listing). A glob that
            passes reaches the lister in ``ScopeMatch.pattern``; the
            mount serves no stored window for a glob. Any other glob,
            and any other kind, lists as usual.
        leaf_error (Literal["enoent", "enotdir"]): what listing a leaf
            raises; fixed hierarchies historically answer ENOENT.
        extras (Mapping[str, ExtraFn] | None): per-kind ``FileStat.extra``
            payloads derived from a listed row's own slots.
    """

    globbed_kinds = pattern_kinds if pattern_kinds is not None else {}
    resolved = entry_listers if entry_listers is not None else {}
    parented = parent_entry_listers if parent_entry_listers is not None else {}
    shaped = extras if extras is not None else {}
    tables = [set(listers), set(resolved), set(parented)]
    overlap = (
        (tables[0] & tables[1])
        | (tables[0] & tables[2])
        | (tables[1] & tables[2])
    )
    if overlap:
        raise ValueError(f"kinds in several lister tables: {sorted(overlap)}")

    def finish(row: FileStat, folder: str) -> FileStat:
        match = detect(f"{folder}/{row.name}")
        update: dict[str, Any] = {}
        extra_fn = shaped.get(match.kind)
        if extra_fn is not None:
            update["extra"] = {**row.extra, **extra_fn(match)}
        scope = match.scope
        if (
            row.type is FileType.FILE
            and row.content is None
            and scope is not None
            and scope.leaf
        ):
            update["content"] = scope.filetype or ContentType.JSON
        return row.model_copy(update=update) if update else row

    def shown(rows: list[FileStat], folder: str) -> list[FileStat]:
        return [
            finish(row, folder) for row in rows if not row.name.startswith(".")
        ]

    async def readdir(
        accessor: A,
        path_spec: PathSpec,
        entry: FileStat | None = None,
        parent: FileStat | None = None,
        limit: int | None = None,
    ) -> list[FileStat] | DirListing:
        virtual = path_spec.virtual
        path = (path_spec.dir if path_spec.pattern else path_spec).mount_path
        folder = path.rstrip("/")
        match = detect(path)
        if match.kind == INVALID:
            raise enoent(virtual)
        pushable = globbed_kinds.get(match.kind)
        if (
            path_spec.pattern is not None
            and pushable is not None
            and pushable(path_spec.pattern)
        ):
            match = replace(match, pattern=path_spec.pattern)
        if limit is not None:
            match = replace(match, limit=limit)
        if match.kind == ROOT and static_root is not None:
            return shown(
                [
                    FileStat(name=d, type=FileType.DIRECTORY)
                    for d in static_root
                ],
                folder,
            )
        lister = listers.get(match.kind)
        entry_lister = resolved.get(match.kind)
        parent_lister = parented.get(match.kind)
        if lister is None and entry_lister is None and parent_lister is None:
            if (
                match.scope is not None
                and match.scope.leaf
                and leaf_error == "enotdir"
            ):
                raise enotdir(virtual)
            raise enoent(virtual)
        guard = guards.get(match.kind) if guards is not None else None
        if guard is not None:
            await guard(accessor, match, virtual)
        if entry_lister is not None:
            if entry is None:
                raise enoent(virtual)
            listed = await entry_lister(accessor, match, entry)
        elif parent_lister is not None:
            if parent is None:
                raise enoent(virtual)
            listed = await parent_lister(accessor, match, parent)
        else:
            assert lister is not None
            maybe = await lister(accessor, match)
            if maybe is None:
                raise enoent(virtual)
            listed = maybe
        if not isinstance(listed, DirListing):
            return shown(listed, folder)
        return replace(
            listed,
            entries=shown(listed.entries, folder),
            seeds={
                rel: shown(rows, f"{folder}/{rel.strip('/')}")
                for rel, rows in listed.seeds.items()
            },
        )

    return readdir
