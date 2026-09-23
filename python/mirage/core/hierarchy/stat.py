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

from collections.abc import Awaitable, Callable, Mapping

from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.hierarchy.probe import (A, ReaddirFn, assert_listed,
                                         listed_size, resolve_entry)
from mirage.core.hierarchy.readdir import Guard
from mirage.core.hierarchy.scope import ROOT, DetectFn, ScopeMatch
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.errors import enoent

ExtraFn = Callable[[ScopeMatch], dict[str, str]]
StatHook = Callable[[A, ScopeMatch, PathSpec, IndexCacheStore],
                    Awaitable[FileStat]]
EntryStatFn = Callable[[ScopeMatch, PathSpec, IndexEntry], FileStat]


def entry_stat(id_field: str, filetype: ContentType | FileType) -> EntryStatFn:
    """The shape most id-addressed nodes share, keyed by an id field.

    Name from the entry's ``vfs_name``, size and modified straight off
    the listing, and the entry's id under ``id_field`` in ``extra``. A
    kind whose shape differs writes its own ``EntryStatFn`` instead.

    ``filetype`` is the node's kind: a ``FileType`` for a non-regular
    node (a directory entry, e.g. a linear team or trello board) or a
    ``ContentType`` for a regular file, whose node kind is then FILE.

    Args:
        id_field (str): the ``extra`` key the entry's id rides under.
        filetype (ContentType | FileType): the node's kind.
    """

    def build(match: ScopeMatch, path: PathSpec,
              entry: IndexEntry) -> FileStat:
        if isinstance(filetype, FileType):
            return FileStat(
                name=entry.vfs_name,
                type=filetype,
                size=entry.size,
                modified=entry.remote_time or None,
                extra={id_field: entry.id},
            )
        return FileStat(
            name=entry.vfs_name,
            type=FileType.FILE,
            content=filetype,
            size=entry.size,
            modified=entry.remote_time or None,
            extra={id_field: entry.id},
        )

    return build


def make_stat(
    detect: DetectFn,
    readdir: ReaddirFn[A],
    *,
    guards: Mapping[str, Guard[A]] | None = None,
    extras: Mapping[str, ExtraFn] | None = None,
    overrides: Mapping[str, StatHook[A]] | None = None,
    entry_stats: Mapping[str, EntryStatFn] | None = None,
) -> Callable[..., Awaitable[FileStat]]:
    """Build a hierarchy stat: existence probes and shapes per scope.

    Directories answer as themselves once proven to exist; leaves prove
    existence through their parent's listing and pick up any size that
    listing recorded. A guard replaces the parent-listing probe for
    kinds whose existence the API answers directly; an override replaces
    the whole shape for kinds with bespoke stats.

    Args:
        detect (DetectFn): the backend's scope classifier.
        readdir (ReaddirFn): the backend's readdir, for the
            parent-listing probe.
        guards (Mapping[str, Guard]): per-kind existence checks used
            instead of the parent listing.
        extras (Mapping[str, ExtraFn]): per-kind ``FileStat.extra``
            payloads derived from the slots.
        overrides (Mapping[str, StatHook]): per-kind full replacements.
        entry_stats (Mapping[str, EntryStatFn]): per-kind shapes built
            from the path's own index entry, for id-addressed backends
            whose listing already carries the stat (Drive-item trees);
            the kit resolves the entry through the parent readdir and an
            absent entry is ENOENT.
    """

    async def stat(accessor: A,
                   path: PathSpec,
                   index: IndexCacheStore = NULL_INDEX) -> FileStat:
        if index is NULL_INDEX or index is None:
            # Entry resolution and listed_size read what the probe's
            # parent listing just wrote, so a caller with no cache still
            # needs one for the duration of the call. None arrives from
            # bare commands built outside a workspace (the TS twin's ??
            # treats null and undefined alike).
            index = RAMIndexCacheStore()
        virtual = path.virtual
        match = detect(path)
        if match.kind == ROOT:
            return FileStat(name="/", type=FileType.DIRECTORY)
        scope = match.scope
        if scope is None:
            raise enoent(virtual)
        override = (overrides.get(match.kind)
                    if overrides is not None else None)
        if override is not None:
            return await override(accessor, match, path, index)
        guard = guards.get(match.kind) if guards is not None else None
        entry_fn = (entry_stats.get(match.kind)
                    if entry_stats is not None else None)
        if entry_fn is not None:
            if guard is not None:
                await guard(accessor, match, virtual)
            entry = await resolve_entry(readdir, accessor, path, index)
            if entry is None:
                raise enoent(virtual)
            return entry_fn(match, path, entry)
        if guard is not None:
            await guard(accessor, match, virtual)
        elif scope.probed:
            await assert_listed(readdir, accessor, path, index)
        name = path.vfs_path.strip("/").split("/")[-1]
        extra_fn = extras.get(match.kind) if extras is not None else None
        extra = extra_fn(match) if extra_fn is not None else {}
        if not scope.leaf:
            return FileStat(name=name, type=FileType.DIRECTORY, extra=extra)
        return FileStat(
            name=name,
            type=FileType.FILE,
            content=scope.filetype
            if scope.filetype is not None else ContentType.JSON,
            size=await listed_size(index, path),
            extra=extra,
        )

    return stat
