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

import asyncio
import posixpath
import re
from bisect import bisect_left
from collections.abc import Callable, Mapping, Sequence
from dataclasses import replace
from io import BytesIO
from os.path import commonprefix

from dulwich.config import ConfigFile
from dulwich.objects import ObjectID, ShaFile, Tag
from dulwich.refs import Ref
from dulwich.repo import BaseRepo
from dulwich.walk import Walker

from mirage.commands.cli.builtin.git.constants import DWIM_RULES
from mirage.commands.cli.builtin.git.errors import GitError
from mirage.commands.cli.builtin.git.format import short
from mirage.commands.cli.builtin.git.io import read_names, read_optional
from mirage.commands.cli.builtin.git.mailmap import load_mailmap
from mirage.commands.cli.builtin.git.objects import FANOUT_LEN, abbrev_for
from mirage.commands.cli.builtin.git.ref_fields import (
    abbreviation_requests,
    needs_object,
)
from mirage.commands.cli.builtin.git.ref_filter import RefFilter, kept_refs
from mirage.commands.cli.builtin.git.ref_format import parse_sort_keys
from mirage.commands.cli.builtin.git.refs import mapped, parse_refspec
from mirage.commands.cli.builtin.git.render import (
    DETACHED_AT,
    DETACHED_FROM,
    NO_BRANCH,
)
from mirage.commands.cli.builtin.git.types import (
    DateMode,
    HeadRef,
    RefContext,
    RefField,
    RefItem,
    RefKind,
    RefObject,
    RefSortKey,
    RefUpstream,
    RepoLocation,
)
from mirage.commands.cli.builtin.git.util import git_bool
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import IOResult
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import encode_text
from mirage.utils.fnmatch import fnmatch

SYMREF_PREFIX = "ref: "
# git follows a chain of symbolic refs this deep before it gives up.
SYMREF_DEPTH = 5
ROOT_REF_SYNTAX = re.compile(r"[A-Z_]+")
PSEUDO_REFS = ("FETCH_HEAD", "MERGE_HEAD")
IRREGULAR_ROOT_REFS = (
    "HEAD",
    "AUTO_MERGE",
    "BISECT_EXPECTED_REV",
    "NOTES_MERGE_PARTIAL",
    "NOTES_MERGE_REF",
    "MERGE_AUTOSTASH",
)
KIND_PREFIXES = (
    ("refs/heads/", RefKind.BRANCH),
    ("refs/remotes/", RefKind.REMOTE),
    ("refs/tags/", RefKind.TAG),
)
# match_pattern strips the first of these before a tag or branch pattern
# is matched, so `v1.*` and `origin/*` name refs by their short names.
SHORT_PREFIXES = ("refs/tags/", "refs/heads/", "refs/remotes/", "refs/")
WORKTREES = "worktrees"
GITDIR_FILE = "gitdir"
HEAD_FILE = "HEAD"


def is_root_ref(name: str) -> bool:
    """``is_root_ref``: a ref living beside HEAD rather than under
    ``refs/``, pseudorefs (``FETCH_HEAD``) excluded.

    Args:
        name (str): a name at the top of the git directory.
    """
    if not ROOT_REF_SYNTAX.fullmatch(name) or name in PSEUDO_REFS:
        return False
    return name.endswith("_HEAD") or name in IRREGULAR_ROOT_REFS


def ref_kind(name: str) -> RefKind:
    """``ref_kind_from_refname``: which part of the namespace a ref is in.

    Args:
        name (str): the full ref name.
    """
    for prefix, kind in KIND_PREFIXES:
        if name.startswith(prefix):
            return kind
    if name == HEAD_FILE:
        return RefKind.DETACHED
    return RefKind.ROOT if is_root_ref(name) else RefKind.OTHER


def resolve_ref(
    table: Mapping[str, str], name: str
) -> tuple[str | None, str | None]:
    """What a ref resolves to, following symbolic refs as git reads them.

    Args:
        table (Mapping[str, str]): each ref's raw value, an id or a
            ``ref: <target>`` line.
        name (str): the ref.

    Returns:
        tuple[str | None, str | None]: the object id, None for a ref that
        does not resolve (a dangling symref); and the target a symbolic
        ref names, None for an ordinary ref.
    """
    raw = table.get(name)
    target = (
        raw[len(SYMREF_PREFIX) :].strip()
        if raw is not None and raw.startswith(SYMREF_PREFIX)
        else None
    )
    current = name
    for _ in range(SYMREF_DEPTH + 1):
        value = table.get(current)
        if value is None:
            return None, target
        if not value.startswith(SYMREF_PREFIX):
            return value.strip(), target
        current = value[len(SYMREF_PREFIX) :].strip()
    return None, target


def known_names(
    table: Mapping[str, str], root_files: Sequence[str] = ()
) -> frozenset[str]:
    """Every name that resolves, which is what makes a short name
    ambiguous: each ref, and the root refs the git directory holds.

    Args:
        table (Mapping[str, str]): each ref's raw value.
        root_files (Sequence[str]): the names at the top of the git
            directory.
    """
    names = {name for name in table if resolve_ref(table, name)[0]}
    names.update(
        name for name in root_files if ROOT_REF_SYNTAX.fullmatch(name)
    )
    return frozenset(names)


def _path_match(parts: list[str], name: list[str]) -> bool:
    """Match a pattern against a ref one component at a time.

    Args:
        parts (list[str]): the pattern's ``/``-separated components.
        name (list[str]): the ref name's components.
    """
    if not parts:
        return not name
    head, rest = parts[0], parts[1:]
    if head == "**":
        return any(_path_match(rest, name[i:]) for i in range(len(name) + 1))
    return (
        bool(name) and fnmatch(name[0], head) and _path_match(rest, name[1:])
    )


def _folded(text: str, icase: bool) -> str:
    return "".join(
        chr(ord(c) + 32) if icase and "A" <= c <= "Z" else c for c in text
    )


def match_as_path(
    name: str, patterns: Sequence[str], icase: bool = False
) -> bool:
    """``match_name_as_path``: for-each-ref's pattern rule.

    A pattern selects a ref it spells in full or up to a ``/`` (always
    case-sensitively), or one it matches as a ``WM_PATHNAME`` glob:
    ``*`` stops at a ``/``, so ``refs/*`` selects nothing while
    ``refs/*/*`` and ``refs/**`` select every branch (git 2.47.3 and
    2.50.1). No pattern selects every ref.

    Args:
        name (str): the full ref name.
        patterns (Sequence[str]): the operands.
        icase (bool): ``--ignore-case``, which folds the glob only.
    """
    if not patterns:
        return True
    components = _folded(name, icase).split("/")
    for pattern in patterns:
        if name.startswith(pattern) and (
            len(name) == len(pattern)
            or name[len(pattern)] == "/"
            or pattern.endswith("/")
        ):
            return True
        if _path_match(_folded(pattern, icase).split("/"), components):
            return True
    return False


def match_short(
    name: str, patterns: Sequence[str], icase: bool = False
) -> bool:
    """``match_pattern``: tag's and branch's pattern rule, a glob over
    the name less its ``refs/tags/``, ``refs/heads/``, ``refs/remotes/``
    or ``refs/``, where ``*`` crosses a ``/``.

    Args:
        name (str): the full ref name.
        patterns (Sequence[str]): the operands, none selecting every ref.
        icase (bool): ``--ignore-case``.
    """
    if not patterns:
        return True
    short = next(
        (name[len(p) :] for p in SHORT_PREFIXES if name.startswith(p)), name
    )
    return any(
        fnmatch(_folded(short, icase), _folded(pattern, icase))
        for pattern in patterns
    )


def _object(repo: BaseRepo, oid: str) -> RefObject:
    obj: ShaFile = repo.object_store[ObjectID(oid.encode())]
    return RefObject(
        oid=oid, type=obj.type_name.decode(), raw=obj.as_raw_string()
    )


def _peeled(repo: BaseRepo, obj: RefObject) -> RefObject:
    """What a tag object peels to, through any tags it names in turn.

    Args:
        repo (BaseRepo): the opened repository.
        obj (RefObject): the tag.
    """
    shown: ShaFile = repo.object_store[ObjectID(obj.oid.encode())]
    while isinstance(shown, Tag):
        shown = repo.object_store[shown.object[1]]
    return RefObject(
        oid=shown.id.decode(),
        type=shown.type_name.decode(),
        raw=shown.as_raw_string(),
    )


def listed_refs(
    repo: BaseRepo,
    table: Mapping[str, str],
    wanted: Callable[[str], bool],
    fields: Sequence[RefField],
) -> tuple[list[RefItem], str]:
    """The refs a listing holds, in name order, each loaded as far as
    its fields read it.

    As git's ref iteration does, a ref that does not resolve (a
    dangling symbolic ref) is skipped silently, and one naming an
    object the repository lacks is skipped with git's error. Synchronous,
    for a worker thread.

    Args:
        repo (BaseRepo): the opened repository.
        table (Mapping[str, str]): each ref's raw value, by name.
        wanted (Callable[[str], bool]): whether a ref name is listed.
        fields (Sequence[RefField]): every field the listing reads.

    Returns:
        tuple[list[RefItem], str]: the refs, and what git would write to
        stderr about the ones it skipped.
    """
    objects = any(needs_object(field) for field in fields)
    peeled = any(field.deref for field in fields)
    items: list[RefItem] = []
    errors: list[str] = []
    for name in sorted(table):
        if not wanted(name):
            continue
        oid, symref = resolve_ref(table, name)
        if oid is None:
            continue
        if ObjectID(oid.encode()) not in repo.object_store:
            errors.append(f"error: {name} does not point to a valid object!\n")
            continue
        item = RefItem(name=name, oid=oid, kind=ref_kind(name), symref=symref)
        if objects:
            obj = _object(repo, oid)
            item = replace(
                item,
                obj=obj,
                peeled=_peeled(repo, obj)
                if peeled and obj.type == "tag"
                else None,
            )
        items.append(item)
    return items, "".join(errors)


def ref_table(repo: BaseRepo) -> dict[str, str]:
    """Each ref's raw value by name: an id, or a ``ref:`` line.

    Args:
        repo (BaseRepo): the opened repository.
    """
    table: dict[str, str] = {}
    for key in repo.refs.allkeys():
        raw = repo.refs.read_loose_ref(key)
        if raw is not None:
            table[key.decode("utf-8", "replace")] = raw.decode(
                "utf-8", "replace"
            )
    return table


def config_values(
    cfg: ConfigFile, section: tuple[bytes, ...], name: bytes
) -> list[bytes]:
    """Every value one variable takes in a config section, in order.

    Args:
        cfg (ConfigFile): the config.
        section (tuple[bytes, ...]): the section, and its subsection
            when it has one.
        name (bytes): the variable, lowercase.
    """
    if not cfg.has_section(section):
        return []
    return [value for key, value in cfg.items(section) if key.lower() == name]


def tracking_ref(
    cfg: ConfigFile, branch: str, known: frozenset[str]
) -> RefUpstream | None:
    """``branch_get_upstream``: the ref a branch's upstream lands in.

    ``branch.<name>.merge`` is mapped through the remote's fetch
    refspecs; a branch following a remote with none that map it has no
    upstream at all, and one following ``.`` follows a local ref.

    Args:
        cfg (ConfigFile): the repository's config.
        branch (str): the branch's short name.
        known (frozenset[str]): every name that resolves, for ``.``.
    """
    section = (b"branch", branch.encode())
    remotes = config_values(cfg, section, b"remote")
    merges = config_values(cfg, section, b"merge")
    if not remotes or not merges:
        return None
    remote, merged = remotes[-1].decode(), merges[0].decode()
    for text in config_values(cfg, (b"remote", remote.encode()), b"fetch"):
        spec = parse_refspec(text.decode())
        if spec.src.startswith("^"):
            continue
        dst = mapped(spec, merged)
        if dst:
            return RefUpstream(ref=dst, remote=remote, merge=merged)
    if remote != ".":
        return None
    found = next(
        (
            rule.format(merged)
            for rule in DWIM_RULES
            if rule.format(merged) in known
        ),
        merged,
    )
    return RefUpstream(ref=found, remote=remote, merge=merged)


def with_upstreams(
    repo: BaseRepo,
    cfg: ConfigFile,
    items: list[RefItem],
    table: Mapping[str, str],
    known: frozenset[str],
    counted: bool,
) -> list[RefItem]:
    """Each local branch with its upstream and, when a field reads
    them, how far the two have moved apart. Synchronous, for a worker
    thread: the counts walk history.

    Args:
        repo (BaseRepo): the opened repository.
        cfg (ConfigFile): the repository's config.
        items (list[RefItem]): the refs.
        table (Mapping[str, str]): each ref's raw value.
        known (frozenset[str]): every name that resolves.
        counted (bool): whether a field reads ahead/behind counts.
    """
    out: list[RefItem] = []
    for item in items:
        if not item.name.startswith("refs/heads/"):
            out.append(item)
            continue
        up = tracking_ref(cfg, item.name[len("refs/heads/") :], known)
        if up is not None:
            theirs, _ = resolve_ref(table, up.ref)
            if theirs is None:
                up = replace(up, gone=True)
            elif counted:
                ours = {
                    e.commit.id
                    for e in Walker(
                        repo.object_store, [ObjectID(item.oid.encode())]
                    )
                }
                there = {
                    e.commit.id
                    for e in Walker(
                        repo.object_store, [ObjectID(theirs.encode())]
                    )
                }
                up = replace(
                    up, ahead=len(ours - there), behind=len(there - ours)
                )
        out.append(replace(item, upstream=up))
    return out


async def read_config(
    dispatch: DispatchFn, location: RepoLocation
) -> ConfigFile:
    """The repository's own config, empty when it has none.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        location (RepoLocation): the discovered repository.
    """
    data = await read_optional(dispatch, f"{location.commondir}/config")
    return ConfigFile.from_file(BytesIO(data or b""))


async def root_names(
    dispatch: DispatchFn, location: RepoLocation
) -> list[str]:
    """The names at the top of this checkout's git directory.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        location (RepoLocation): the discovered repository.
    """
    return [
        posixpath.basename(entry)
        for entry in await read_names(dispatch, location.gitdir)
    ]


async def worktree_heads(
    dispatch: DispatchFn, location: RepoLocation
) -> dict[str, str]:
    """``get_worktrees``: the branch each worktree has checked out, and
    where that worktree is.

    The main worktree is the one this repository was found in or the
    one around its common directory; a linked one is named by the
    ``gitdir`` file git keeps for it, less its ``/.git``.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        location (RepoLocation): the discovered repository.
    """
    heads: dict[str, str] = {}

    async def note(gitdir: str, path: str) -> None:
        data = await read_optional(dispatch, f"{gitdir}/{HEAD_FILE}")
        text = (data or b"").decode("utf-8", "replace").strip()
        if text.startswith(SYMREF_PREFIX) and path:
            heads.setdefault(text[len(SYMREF_PREFIX) :].strip(), path)

    common = location.commondir
    if location.gitdir == common:
        main = location.worktree
    else:
        main = (
            posixpath.dirname(common)
            if posixpath.basename(common) == ".git"
            else ""
        )
    await note(common, main)
    root = f"{common}/{WORKTREES}"
    for entry in await read_names(dispatch, root):
        linked = f"{root}/{posixpath.basename(entry)}"
        data = await read_optional(dispatch, f"{linked}/{GITDIR_FILE}")
        if data is None:
            continue
        path = data.decode("utf-8", "replace").strip()
        await note(
            linked, path[: -len("/.git")] if path.endswith("/.git") else path
        )
    return heads


CHECKOUT_MOVE = "checkout: moving from "


def _detached_label(repo: BaseRepo, target: str, moved: bytes) -> str:
    """How the status names where a detached HEAD came from.

    The checkout's target when it still names exactly one ref holding
    that commit (a tag or remote-tracking branch by its short name), the
    abbreviated id otherwise.

    Args:
        repo (BaseRepo): the opened repository.
        target (str): what the checkout was asked for.
        moved (bytes): the commit it moved HEAD to.
    """
    refs = repo.refs.allkeys()
    found = [
        name
        for name in dict.fromkeys(rule.format(target) for rule in DWIM_RULES)
        if name.encode() in refs
    ]
    if target != "HEAD" and len(found) == 1:
        obj = repo.object_store[repo.refs[Ref(found[0].encode())]]
        while isinstance(obj, Tag):
            obj = repo.object_store[obj.object[1]]
        if obj.id == moved:
            return (
                found[0]
                .removeprefix("refs/tags/")
                .removeprefix("refs/remotes/")
            )
    return short(moved, abbrev_for(repo))


async def detached_line(
    dispatch: DispatchFn, repo: BaseRepo, location: RepoLocation, head: HeadRef
) -> str:
    """The first line of a status on a detached HEAD, read off the reflog.

    git names the target of the newest ``checkout: moving from`` entry,
    ``at`` while HEAD is still there and ``from`` once it has moved on,
    and says it is on no branch when no checkout put it there, which is
    what a clone of a tag or of a detached HEAD reads (pinned against
    git 2.47.3 and 2.50.1).

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        repo (BaseRepo): the opened repository.
        location (RepoLocation): the discovered repository.
        head (HeadRef): what HEAD points at.
    """
    log = await read_optional(
        dispatch, posixpath.join(location.gitdir, "logs/HEAD")
    )
    for row in reversed((log or b"").splitlines()):
        record, _, message = row.partition(b"\t")
        text = message.decode("utf-8", "replace")
        if not text.startswith(CHECKOUT_MOVE) or " to " not in text:
            continue
        target = text[len(CHECKOUT_MOVE) :].split(" to ", 1)[1]
        moved = record.split(b" ")[1]
        label = await asyncio.to_thread(_detached_label, repo, target, moved)
        at = head.commit is not None and head.commit.encode() == moved
        return f"{DETACHED_AT if at else DETACHED_FROM}{label}"
    return NO_BRANCH


async def head_description(
    dispatch: DispatchFn, repo: BaseRepo, location: RepoLocation, head: HeadRef
) -> str:
    """``get_head_description``: how a detached HEAD row names itself
    in a branch listing, the status line in parentheses.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        repo (BaseRepo): the opened repository.
        location (RepoLocation): the discovered repository.
        head (HeadRef): what HEAD points at.
    """
    line = await detached_line(dispatch, repo, location, head)
    return "(no branch)" if line == NO_BRANCH else f"({line})"


def head_ref(table: Mapping[str, str]) -> str | None:
    """The ref HEAD resolves to, ``HEAD`` itself when it is detached, None
    when it names a branch with no commit yet.

    Args:
        table (Mapping[str, str]): each ref's raw value.
    """
    current = HEAD_FILE
    for _ in range(SYMREF_DEPTH + 1):
        value = table.get(current)
        if value is None:
            return None
        if not value.startswith(SYMREF_PREFIX):
            return current
        current = value[len(SYMREF_PREFIX) :].strip()
    return None


def _mailmapped(fields: Sequence[RefField]) -> bool:
    return any(
        field.option == "mailmap" or "mailmap" in field.words
        for field in fields
    )


def unique_width(oid: str, width: int, ids: Sequence[str]) -> int:
    """The shortest prefix of ``oid`` no other id shares, no shorter than
    ``width``, as git's ``find_abbrev_len_for_pack`` finds it.

    In sorted ids the longest prefix any other id shares with ``oid`` is
    shared by a neighbour of the place it sorts to, so only those two
    are compared. An id the repository lacks (a missing parent) sorts
    between its neighbours all the same.

    Args:
        oid (str): the full hex id.
        width (int): the width asked for.
        ids (Sequence[str]): every id sharing its fanout byte, sorted.
    """
    at = bisect_left(ids, oid)
    after = at + 1 if at < len(ids) and ids[at] == oid else at
    for other in [*ids[max(at - 1, 0) : at], *ids[after : after + 1]]:
        width = max(width, len(commonprefix([oid, other])) + 1)
    return min(width, len(oid))


def unique_abbreviations(
    repo: BaseRepo, widths: Mapping[str, int]
) -> dict[str, int]:
    """Widen requested prefixes against loose and packed objects, including
    objects no selected ref reaches, without reading object contents.

    Each fanout bucket the ids fall in is read once, so a listing of many
    branches costs one pass over the ids those buckets hold rather than
    one per branch.

    Args:
        repo (BaseRepo): the opened repository.
        widths (Mapping[str, int]): the smallest requested width per id.
    """
    buckets: dict[str, list[str]] = {}
    for oid in widths:
        buckets.setdefault(oid[:FANOUT_LEN], [])
    for fanout, ids in buckets.items():
        ids.extend(
            sorted(
                {
                    found.decode()
                    for found in repo.object_store.iter_prefix(fanout.encode())
                }
            )
        )
    return {
        oid: unique_width(oid, width, buckets[oid[:FANOUT_LEN]])
        for oid, width in widths.items()
    }


async def ref_listing(
    dispatch: DispatchFn,
    repo: BaseRepo,
    location: RepoLocation,
    cfg: ConfigFile,
    fields: Sequence[RefField],
    wanted: Callable[[str], bool],
    filt: RefFilter | None,
    date: DateMode,
    roots: bool = False,
) -> tuple[list[RefItem], RefContext, str]:
    """The refs one listing prints and the facts their fields read.

    Everything a field could want is loaded only when some field wants
    it: the objects, what tags peel to, upstreams and their counts,
    worktrees and the mailmap.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        repo (BaseRepo): the opened repository.
        location (RepoLocation): the discovered repository.
        cfg (ConfigFile): the repository's config.
        fields (Sequence[RefField]): every field the listing reads.
        wanted (Callable[[str], bool]): whether a ref name is listed.
        filt (RefFilter | None): the resolved ref filter.
        date (DateMode): the invocation's clock.
        roots (bool): ``--include-root-refs``: list the root refs the
            git directory holds as well.

    Returns:
        tuple[list[RefItem], RefContext, str]: the refs in name order,
        the listing's facts, and git's errors about skipped refs.
    """
    table = ref_table(repo)
    names = await root_names(dispatch, location)
    if roots:
        for name in names:
            if name == HEAD_FILE or not is_root_ref(name):
                continue
            data = await read_optional(dispatch, f"{location.gitdir}/{name}")
            if data:
                table[name] = data.decode("utf-8", "replace").split("\n", 1)[0]
    known = known_names(table, names)
    items, errors = await asyncio.to_thread(
        listed_refs, repo, table, wanted, fields
    )
    if filt is not None:
        pairs = [(item.name, item.oid.encode()) for item in items]
        kept = await asyncio.to_thread(kept_refs, repo, filt, pairs)
        items = [item for item in items if item.name in kept]
    upstreams = [field for field in fields if field.field == "upstream"]
    if upstreams:
        counted = any(
            field.option in ("track", "trackshort") for field in upstreams
        )
        items = await asyncio.to_thread(
            with_upstreams, repo, cfg, items, table, known, counted
        )
    if any(field.field == "worktreepath" for field in fields):
        heads = await worktree_heads(dispatch, location)
        items = [
            replace(item, worktree=heads.get(item.name, "")) for item in items
        ]
    suffixes = config_values(
        cfg, (b"versionsort",), b"suffix"
    ) or config_values(cfg, (b"versionsort",), b"prereleasesuffix")
    ctx = RefContext(
        known=known,
        strict=git_bool(
            config_values(cfg, (b"core",), b"warnambiguousrefs"),
            "core.warnambiguousrefs",
            True,
        ),
        head=head_ref(table),
        abbrev=abbrev_for(repo),
        mailmap=await load_mailmap(dispatch, location)
        if _mailmapped(fields)
        else (),
        date=date,
        suffixes=tuple(value.decode("utf-8", "replace") for value in suffixes),
    )
    widths = abbreviation_requests(fields, items, ctx)
    if widths:
        ctx = replace(
            ctx,
            abbreviations=await asyncio.to_thread(
                unique_abbreviations, repo, widths
            ),
        )
    return items, ctx, errors


def sort_keys(
    fl: FlagView, defaults: Sequence[str]
) -> tuple[RefSortKey, ...] | None:
    """The line's sort keys, primary first; None when there are none.

    Each ``--sort`` adds a key after the defaults (the config's
    ``<verb>.sort`` values, or ``refname``) and ``--no-sort`` drops
    every key before it, the defaults included, as git's string list
    does.

    Args:
        fl (FlagView): spec-bound options.
        defaults (Sequence[str]): the keys a line starts with.
    """
    spellings = list(defaults)
    for name, value in fl.occurrences("sort", "no_sort"):
        if name == "no_sort":
            spellings = []
        elif isinstance(value, list):
            spellings.extend(v for v in value if isinstance(v, str))
        elif isinstance(value, str):
            spellings.append(value)
    return parse_sort_keys(spellings) if spellings else None


def configured_sort(cfg: ConfigFile, verb: bytes) -> tuple[str, ...]:
    """``tag.sort`` or ``branch.sort``: the keys a listing sorts by
    unless the line says otherwise, ``refname`` when unset.

    Args:
        cfg (ConfigFile): the repository's config.
        verb (bytes): ``tag`` or ``branch``.
    """
    values = config_values(cfg, (verb,), b"sort")
    return (
        tuple(v.decode("utf-8", "replace") for v in values)
        if values
        else ("refname",)
    )


def listing_result(
    out: str, errors: str, stopped: GitError | None
) -> tuple[bytes, IOResult]:
    """A listing's output: what printed, then the refusal it stopped at.

    Args:
        out (str): the rows printed.
        errors (str): git's errors about refs it skipped.
        stopped (GitError | None): the error the listing stopped at.
    """
    stderr = errors
    if stopped is not None:
        stderr += (
            f"{stopped}\n"
            if stopped.prefix is None
            else f"{stopped.prefix}: {stopped}\n"
        )
    return encode_text(out), IOResult(
        exit_code=stopped.code if stopped is not None else 0,
        stderr=stderr.encode(),
    )
