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
from dataclasses import dataclass, field, replace
from typing import Literal

from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.hierarchy.probe import A, ReaddirFn, resolve_entry
from mirage.core.hierarchy.scope import INVALID, ROOT, DetectFn, ScopeMatch
from mirage.types import PathSpec
from mirage.utils.errors import enoent, enotdir
from mirage.utils.key_prefix import mount_key, mount_prefix_of


@dataclass(frozen=True, slots=True)
class DirListing:
    """A listing that also proves descendant listings.

    For a backend whose one fetch answers more than one directory: a
    dated-message day fetch yields the day's own children AND the
    contents of its ``files/`` subdirectory, and a mail label listing
    yields the date directories AND each date's messages AND each
    message's attachment directory. Returning the extra listings as
    seeds lets the kit cache them, so entering a seeded directory costs
    no second identical fetch.

    Args:
        entries (list[tuple[str, IndexEntry]]): the listed directory's
            own children.
        seeds (Mapping[str, list[tuple[str, IndexEntry]]]): descendant
            listings the same fetch proved, keyed by path relative to
            the listed directory (``files``, ``2026-01-05/Report__17``).
        partial (bool): the entries are a filtered or truncated view
            rather than the directory's contents, so they must not be
            cached as the directory: a glob-scoped listing, or one the
            provider did not finish. The entries themselves are real
            either way, so the kit caches those and lets the next
            readdir re-list. ``seeds`` stay full listings of the
            children this fetch did report, so they are cached as
            directories as usual.
    """
    entries: list[tuple[str, IndexEntry]]
    seeds: Mapping[str, list[tuple[str,
                                   IndexEntry]]] = field(default_factory=dict)
    partial: bool = False


Listed = list[tuple[str, IndexEntry]] | DirListing
Lister = Callable[[A, ScopeMatch], Awaitable["Listed | None"]]
EntryLister = Callable[[A, ScopeMatch, IndexEntry], Awaitable[Listed]]
Guard = Callable[[A, ScopeMatch, str], Awaitable[None]]
PatternTest = Callable[[str], bool]


def _drop_hidden(
        listed: list[tuple[str, IndexEntry]]) -> list[tuple[str, IndexEntry]]:
    return [(name, entry) for name, entry in listed
            if not name.startswith(".")]


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
) -> ReaddirFn[A]:
    """Build a hierarchy readdir: dispatch, guards, index, name joins.

    A lister fetches one directory kind and returns ``(vfs_name,
    IndexEntry)`` pairs; everything else — classification, existence
    guards, the index probe and write-back, and virtual name
    construction — happens here, identically for every backend.
    A dot-prefixed name is dropped from the listing: the classifier
    refuses every dot-leading segment, so listing one would advertise a
    path that stat, read and child readdir all report absent.
    A lister may answer None instead of a listing: the directory's
    container does not exist, reported as ENOENT on the virtual path.
    A lister may answer a ``DirListing`` to seed descendant listings its
    fetch already proved; entering a seeded directory then reads the
    index instead of refetching (the entry-lister branch re-checks the
    listing after resolving, because the resolve itself may have run the
    seeding parent).

    An entry lister is for a directory whose existence and contents are
    already proven by its parent's listing: the kit resolves the
    directory's own index entry through ``resolve_entry`` (warming
    parent listings, each one cached) and hands it over, so entering a
    directory a traversal just listed costs no API call at all. A
    container lister that instead re-fetched its ancestor chain per
    directory made a recursive walk quadratic in listing payloads. The
    facts a child listing needs beyond the API's own answers ride the
    parent listing's ``IndexEntry.extra`` (trello stashes each
    ``card.json`` size on the card's directory entry).

    A parent-entry lister is for a directory whose existence is decided
    by its PARENT's entry rather than its own: a dated-message day dir
    is real for any well-formed date under a channel that exists,
    including dates the channel's bounded listing window never minted,
    so the proof is the channel entry and the fetch takes the date from
    the match.

    Args:
        detect (DetectFn): the backend's scope classifier.
        listers (Mapping[str, Lister]): one lister per directory kind;
            include ``root`` for a dynamic mount root.
        entry_listers (Mapping[str, EntryLister]): listers for kinds
            resolved through their parent's listing.
        parent_entry_listers (Mapping[str, EntryLister]): listers handed
            the parent directory's entry instead of their own; a kind
            appears in at most one of the three tables.
        static_root (tuple[str, ...] | None): fixed top-level names, for
            backends whose root never changes; bypasses the index.
        guards (Mapping[str, Guard]): existence checks that run before
            the index probe, so a vanished container is ENOENT even on a
            warm cache.
        pattern_kinds (Mapping[str, PatternTest] | None): one entry per
            kind whose listing is a bounded window, holding the test for
            whether a glob is one its lister can move the window to
            (``has_glob_span`` for a date-keyed listing). A glob that
            passes reaches the lister and the index is not read first,
            because a cached listing is that same window and would
            answer the glob with it. Any other glob, and any other kind,
            keeps the cached listing and never sees a pattern.
        leaf_error (Literal["enoent", "enotdir"]): what listing a leaf
            raises; fixed hierarchies historically answer ENOENT.
    """

    globbed_kinds = pattern_kinds if pattern_kinds is not None else {}
    resolved = entry_listers if entry_listers is not None else {}
    parented = (parent_entry_listers
                if parent_entry_listers is not None else {})
    tables = [set(listers), set(resolved), set(parented)]
    overlap = ((tables[0] & tables[1]) | (tables[0] & tables[2])
               | (tables[1] & tables[2]))
    if overlap:
        raise ValueError(f"kinds in several lister tables: {sorted(overlap)}")

    async def readdir(accessor: A,
                      path_spec: PathSpec,
                      index: IndexCacheStore = NULL_INDEX) -> list[str]:
        if index is NULL_INDEX or index is None:
            # Entry resolution and the parent-listing warm both read what
            # readdir just wrote, so a caller with no cache still needs
            # one for the duration of the call. None arrives from bare
            # commands built outside a workspace (the TS twin's ?? treats
            # null and undefined alike).
            index = RAMIndexCacheStore()
        virtual = path_spec.virtual
        prefix = mount_prefix_of(path_spec.virtual, path_spec.vfs_path)
        path = (path_spec.dir if path_spec.pattern else path_spec).mount_path
        key = path.strip("/")
        virtual_key = prefix + "/" + key if key else prefix or "/"
        match = detect(path)
        if match.kind == INVALID:
            raise enoent(virtual)
        pushable = globbed_kinds.get(match.kind)
        globbed = (path_spec.pattern is not None and pushable is not None
                   and pushable(path_spec.pattern))
        if globbed:
            match = replace(match, pattern=path_spec.pattern)
        if match.kind == ROOT and static_root is not None:
            return [f"{prefix}/{d}" for d in static_root]
        lister = listers.get(match.kind)
        entry_lister = resolved.get(match.kind)
        parent_lister = parented.get(match.kind)
        if lister is None and entry_lister is None and parent_lister is None:
            if (match.scope is not None and match.scope.leaf
                    and leaf_error == "enotdir"):
                raise enotdir(virtual)
            raise enoent(virtual)
        guard = guards.get(match.kind) if guards is not None else None
        if guard is not None:
            await guard(accessor, match, virtual)
        if not globbed:
            listing = await index.list_dir(virtual_key)
            if listing.entries is not None:
                return listing.entries
        if entry_lister is not None or parent_lister is not None:
            proof_key = virtual_key
            if parent_lister is not None:
                proof_key = virtual_key.rsplit("/", 1)[0] or "/"
            own = await resolve_entry(
                readdir, accessor,
                PathSpec(virtual=proof_key,
                         directory=proof_key,
                         vfs_path=mount_key(proof_key, prefix)), index)
            if own is None:
                raise enoent(virtual)
            # The resolve may have warmed this very listing: a parent's
            # lister can seed a child listing from the same fetch
            # (DirListing.seeds), so ask the index again before fetching.
            if not globbed:
                relisted = await index.list_dir(virtual_key)
                if relisted.entries is not None:
                    return relisted.entries
            if entry_lister is not None:
                listed = await entry_lister(accessor, match, own)
            else:
                assert parent_lister is not None
                listed = await parent_lister(accessor, match, own)
        else:
            assert lister is not None
            maybe = await lister(accessor, match)
            if maybe is None:
                raise enoent(virtual)
            listed = maybe
        seeds: Mapping[str, list[tuple[str, IndexEntry]]] = {}
        partial = False
        if isinstance(listed, DirListing):
            seeds = listed.seeds
            partial = listed.partial
            listed = listed.entries
        entries = _drop_hidden(listed)
        stem = virtual_key.rstrip("/")
        if partial:
            for name, entry in entries:
                await index.put(f"{stem}/{name}", entry)
        else:
            await index.set_dir(virtual_key, entries)
        for rel, child_entries in seeds.items():
            await index.set_dir(f"{stem}/{rel.strip('/')}",
                                _drop_hidden(child_entries))
        return [f"{stem}/{name}" for name, _ in entries]

    return readdir
