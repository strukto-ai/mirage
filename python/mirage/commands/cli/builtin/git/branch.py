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
import time
from collections.abc import Mapping, Sequence
from dataclasses import replace
from io import BytesIO

from dulwich.config import ConfigFile
from dulwich.objects import Commit, ObjectID
from dulwich.refs import Ref
from dulwich.repo import BaseRepo
from dulwich.walk import Walker

from mirage.accessor.base import Accessor
from mirage.commands.cli.builtin.git.constants import HEAD
from mirage.commands.cli.builtin.git.dates import date_clock
from mirage.commands.cli.builtin.git.errors import (
    AmbiguousArgumentError,
    AmbiguousObjectNameError,
    BranchExistsError,
    BranchNameRequiredError,
    BranchPointError,
    CheckedOutBranchError,
    GitError,
    InvalidBranchNameError,
    InvalidObjectNameError,
    NoBranchError,
    RefDeleteReadOnlyError,
    RefLockError,
    RefReadOnlyError,
    UnmergedBranchError,
    UsageError,
)
from mirage.commands.cli.builtin.git.format import short
from mirage.commands.cli.builtin.git.io import read_optional, write_file
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.ref_fields import parse_field
from mirage.commands.cli.builtin.git.ref_filter import (
    RefFilter,
    filter_words,
    ref_filter,
    without_filter_values,
)
from mirage.commands.cli.builtin.git.ref_format import (
    ValueTable,
    display_width,
    format_refs,
    listing_format,
    sort_refs,
    used_fields,
)
from mirage.commands.cli.builtin.git.ref_list import (
    configured_sort,
    head_description,
    known_names,
    listing_result,
    match_as_path,
    match_short,
    reached,
    ref_listing,
    ref_table,
    resolve_ref,
    root_names,
    sort_keys,
    tracking_ref,
    worktree_heads,
)
from mirage.commands.cli.builtin.git.reflog import (
    IDENTITY,
    ZERO,
    append,
    entry,
    logged,
)
from mirage.commands.cli.builtin.git.refs import (
    BRANCH_PREFIX,
    REMOTE_PREFIX,
    SYMREF_PREFIX,
    blocking_ref,
    delete_ref,
    mapped,
    parse_refspec,
    read_head,
    valid_branch_name,
    write_ref,
)
from mirage.commands.cli.builtin.git.repo import (
    Repo,
    config_bool,
    config_values,
    read_config,
)
from mirage.commands.cli.builtin.git.revparse import (
    note_ambiguity,
    refs_named,
    resolve_object,
    unwrapped,
)
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import (
    HeadRef,
    RefContext,
    RefField,
    RefItem,
    RefKind,
    RefSortKey,
    RefUpstream,
    RepoLocation,
    Track,
    Upstream,
)
from mirage.commands.cli.builtin.git.util import (
    check_switches,
    config_section,
    git_bool,
    multivar,
    require_vfs,
    verb_usage,
    without_section,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import decode_text
from mirage.types import PathSpec

REMOTE = "remotes/"
AUTO_SETUP_MERGE = "branch.autosetupmerge"
TRACK_WORDS = (Track.ALWAYS, Track.SIMPLE, Track.INHERIT)
LOCAL_REMOTE = "."
GLOB_CHARS = ("*", "?", "[")
UPSTREAM_KEYS = frozenset({b"remote", b"merge"})
# The order git 2.56.0's --delete-merged deletes in, as pinned on up to 60
# branches: names fall in FNV-1 buckets by their hash, 64 at first and four
# times as many once more than 80% are taken, the latest at each one's head.
FNV_BASIS = 0x811C9DC5
FNV_PRIME = 0x01000193
HASH_BUCKETS = 64
HASH_GROWTH = 4
HASH_LOAD = 80


async def refuse_ambiguous(repo: Repo, name: str, warned: bool) -> None:
    """Refuse a start point two refs answer to.

    As git's branch creation does while ``core.warnAmbiguousRefs`` is
    on, after warning that it is ambiguous. With no start point git
    starts from the current branch by its short name, so that name is
    the one checked.

    Args:
        repo (Repo): the opened repository.
        name (str): the start point as typed, or the current branch's
            short name.
        warned (bool): whether reading it already put the warning on
            the list.

    Raises:
        AmbiguousObjectNameError: two refs answer to the name.
    """
    if not await config_bool(
        repo.dispatch, repo.location, b"core", b"warnambiguousrefs", True
    ):
        return
    known = (ref.decode(errors="replace") for ref in repo.refs.allkeys())
    if len(refs_named(known, name)) <= 1:
        return
    if not warned:
        note_ambiguity(repo, name)
    raise AmbiguousObjectNameError(name)


async def _create(
    repo: Repo,
    name: str,
    start: str | None,
    mode: Track,
    head: HeadRef,
) -> tuple[str, str]:
    """Point a new branch at a commit, refusing to move an existing one.

    Returns what git prints about the upstream it set up, on stdout and
    on stderr.

    Args:
        repo (Repo): the opened repository.
        name (str): the branch name.
        start (str | None): the revision to start it at, HEAD when None.
        mode (Track): ``branch.autoSetupMerge``.
        head (HeadRef): what HEAD points at.
    """
    # Before the start point resolves, which is git's order here and
    # the opposite of switch's. A ref is a path below .git, so an
    # unchecked name reaches write_ref as one.
    if not valid_branch_name(name):
        raise InvalidBranchNameError(name)
    ref = f"{BRANCH_PREFIX}{name}"
    if Ref(ref.encode()) in repo.refs.allkeys():
        raise BranchExistsError(name)
    # With no start point git starts from the current branch by its
    # short name, or from HEAD when it is detached, and it is that name
    # the refusals and the new branch's log speak of.
    origin = start or head.branch or HEAD
    try:
        found = await asyncio.to_thread(resolve_object, repo, origin)
    except AmbiguousArgumentError as exc:
        raise InvalidObjectNameError(origin) from exc
    await refuse_ambiguous(repo, origin, True)
    commit = await asyncio.to_thread(unwrapped, repo, found, origin)
    if not isinstance(commit, Commit):
        raise BranchPointError(
            commit.id.decode(), commit.type_name.decode(), origin
        )
    # Last, as it is for git: a ref whose path another ref already
    # holds fails when the lock is taken, so a bad start point is
    # reported first.
    held = blocking_ref(repo.refs.allkeys(), ref)
    if held is not None:
        raise RefLockError(ref, held)
    vfs, location = repo.dispatch, repo.location
    await write_ref(vfs, location.commondir, ref, commit.id)
    log = location.commondir.join("logs", ref)
    if await logged(vfs, location, ref, log):
        line = entry(
            ZERO,
            commit.id,
            IDENTITY,
            int(time.time()),
            f"branch: Created from {origin}",
        )
        await append(vfs, location.commondir, f"logs/{ref}", line)
    return await set_up_tracking(repo, name, start, mode, head)


def remote_branch(repo: BaseRepo, name: str) -> str | None:
    """The one remote-tracking branch a missing branch name guesses at.

    ``checkout <name>`` and ``switch <name>`` with no such branch create
    it from ``<remote>/<name>`` when exactly one remote has one.

    Args:
        repo (BaseRepo): the opened repository.
        name (str): the branch name asked for.
    """
    found = [
        ref.decode()
        for ref in repo.refs.allkeys()
        if ref.startswith(REMOTE_PREFIX.encode())
        and ref.endswith(f"/{name}".encode())
        and ref.count(b"/") == 3 + name.count("/")
    ]
    return found[0] if len(found) == 1 else None


async def track_mode(repo: Repo) -> Track:
    """``branch.autoSetupMerge`` from the repository's config.

    The words are case-sensitive and anything else reads as a boolean,
    so ``never`` or ``Always`` is a bad boolean. git reads the variable
    before any command runs, so a verb that can create a branch reads it
    first and fails with nothing written (pinned against git 2.50.1).

    Args:
        repo (Repo): the opened repository.

    Raises:
        BadConfigValueError: a value that is neither a word nor a boolean.
    """
    mode = Track.REMOTE
    for value in await config_values(
        repo.dispatch, repo.location, b"branch", b"autosetupmerge"
    ):
        word = value.decode(errors="replace")
        if word in TRACK_WORDS:
            mode = Track(word)
        else:
            mode = (
                Track.REMOTE
                if git_bool([value], AUTO_SETUP_MERGE, True)
                else Track.OFF
            )
    return mode


def _tracked(
    cfg: ConfigFile, ref: str, branch: str, mode: Track
) -> tuple[str | None, list[str], str, str]:
    """The upstream a new branch takes from its start ref, as git picks it.

    Returns the remote (``.`` for a local branch, None for no upstream),
    the merge refs, what the note puts before each one, and a warning.
    git names a local upstream bare when it picked the branch itself but
    ``./<branch>`` when it copied the remote from another branch.

    Args:
        cfg (ConfigFile): the repository's config.
        ref (str): the start point, as a full ref.
        branch (str): the branch just created.
        mode (Track): ``branch.autoSetupMerge``.
    """
    if ref.startswith(BRANCH_PREFIX):
        source = ref[len(BRANCH_PREFIX) :]
        if mode is Track.ALWAYS:
            return ".", [ref], "", ""
        if mode is not Track.INHERIT:
            return None, [], "", ""
        section = (b"branch", source.encode())
        remotes = multivar(cfg, section, b"remote")
        merges = multivar(cfg, section, b"merge")
        missing = (
            "no remote is set"
            if not remotes
            else "no merge configuration is set"
            if not merges
            else ""
        )
        if missing:
            return (
                None,
                [],
                "",
                (
                    f"warning: asked to inherit tracking from "
                    f"'{source}', but {missing}\n"
                ),
            )
        remote = remotes[-1].decode()
        return remote, [m.decode() for m in merges], f"{remote}/", ""
    if not ref.startswith(REMOTE_PREFIX):
        return None, [], "", ""
    remote, _, name = ref[len(REMOTE_PREFIX) :].partition("/")
    if (
        not name
        or name == HEAD
        or not cfg.has_section((b"remote", remote.encode()))
    ):
        return None, [], "", ""
    if mode is Track.INHERIT:
        return (
            None,
            [],
            "",
            (
                f"warning: asked to inherit tracking from "
                f"'{ref}', but no remote is set\n"
            ),
        )
    if mode is Track.SIMPLE and name != branch:
        return None, [], "", ""
    return remote, [f"{BRANCH_PREFIX}{name}"], f"{remote}/", ""


async def set_up_tracking(
    repo: Repo,
    branch: str,
    start: str | None,
    mode: Track,
    head: HeadRef,
) -> tuple[str, str]:
    """Record a new branch's upstream as ``branch.autoSetupMerge`` asks.

    A start point naming ``<remote>/<branch>`` of a configured remote
    writes ``branch.<new>.remote`` and ``.merge`` unless the mode is
    ``false``; ``always`` also tracks a local branch through remote
    ``.``, and no start point means the branch HEAD was on. Returns the
    note git prints on stdout and any warning for stderr (pinned against
    git 2.47.3 and 2.50.1).

    Args:
        repo (Repo): the opened repository.
        branch (str): the branch just created.
        start (str | None): the start point as typed.
        mode (Track): ``branch.autoSetupMerge``, from ``track_mode``.
        head (HeadRef): HEAD before the branch was made, which a
            missing start point stands for.
    """
    if mode is Track.OFF:
        return "", ""
    typed = start or HEAD
    ref: str | None
    if typed == HEAD:
        ref = head.ref
    else:
        known = (decode_text(ref) for ref in repo.refs.allkeys())
        ref = next(iter(refs_named(known, typed)), None)
    if ref is None:
        return "", ""
    path = repo.location.commondir.join("config")
    data = await read_optional(repo.dispatch, path) or b""
    if data and not data.endswith(b"\n"):
        data += b"\n"
    remote, merges, prefix, warning = _tracked(
        ConfigFile.from_file(BytesIO(data)), ref, branch, mode
    )
    if remote is None:
        return "", warning
    section = config_section(
        "branch",
        branch,
        [("remote", remote)] + [("merge", merge) for merge in merges],
    )
    await write_file(repo.dispatch, path, data + section.encode())
    labels = [
        f"{prefix}{merge.removeprefix(BRANCH_PREFIX)}" for merge in merges
    ]
    if len(labels) == 1:
        return f"branch '{branch}' set up to track '{labels[0]}'.\n", ""
    return (
        f"branch '{branch}' set up to track:\n"
        + "".join(f"  {label}\n" for label in labels)
    ), ""


def head_commit(repo: BaseRepo, head: HeadRef) -> bytes | None:
    """The commit HEAD resolves to, None on an unborn branch.

    HEAD carries an object id only when detached; attached it names a
    ref, which is unset until the first commit.

    Args:
        repo (BaseRepo): the opened repository.
        head (HeadRef): what HEAD points at.
    """
    if head.commit is not None:
        return head.commit.encode()
    if head.ref is None:
        return None
    ref = Ref(head.ref.encode())
    return repo.refs[ref] if ref in repo.refs.allkeys() else None


def _merged(repo: BaseRepo, sha: bytes, head: bytes | None) -> bool:
    """Whether HEAD already holds every commit a branch points at.

    Synchronous, and called on a worker thread: walking ancestry pulls
    commit objects through the dispatcher. The walk stops at the first
    sighting, so a merged branch costs only as much history as separates
    it from HEAD; only a negative answer walks the whole thing, which is
    what any repository without a commit graph pays.

    An unborn HEAD holds nothing, which is git's answer too: on an
    orphan branch every other branch reads as unmerged.

    ``dulwich.graph.can_fast_forward`` answers exactly this question and
    cannot be used: it asks the repository for its grafts and shallow
    boundary, and a bare ``BaseRepo`` raises rather than answering.
    ``Walker`` is what ``log`` already walks with, and it needs only the
    object store.

    Only HEAD is consulted. git also accepts a branch contained in its
    own upstream, and there are no remotes here to have one.

    Args:
        repo (BaseRepo): the opened repository.
        sha (bytes): the branch tip.
        head (bytes | None): the commit HEAD resolves to.
    """
    if head is None:
        return False
    if sha == head:
        return True
    return any(
        entry.commit.id == sha
        for entry in Walker(repo.object_store, [ObjectID(head)])
    )


async def _delete(
    repo: Repo,
    head: HeadRef,
    name: str,
    force: bool,
) -> bytes:
    """Remove a branch, refusing when the removal would lose commits.

    Args:
        repo (Repo): the opened repository.
        head (HeadRef): what HEAD points at.
        name (str): the branch name.
        force (bool): whether ``-D`` was given, which deletes a branch
            HEAD does not contain.
    """
    ref = Ref(f"{BRANCH_PREFIX}{name}".encode())
    if ref not in repo.refs.allkeys():
        raise NoBranchError(name)
    if name == head.branch:
        raise CheckedOutBranchError(name, repo.location.worktree.virtual)
    sha = repo.refs[ref]
    if not force and not await asyncio.to_thread(
        _merged, repo, sha, head_commit(repo, head)
    ):
        raise UnmergedBranchError(name)
    await _drop(repo, name)
    return (
        f"Deleted branch {name} (was {short(sha, abbrev_for(repo))}).\n"
    ).encode()


async def _drop(repo: Repo, name: str) -> None:
    """Remove a branch's ref and its settings.

    Args:
        repo (Repo): the opened repository.
        name (str): the branch name.
    """
    vfs, location = repo.dispatch, repo.location
    await delete_ref(vfs, location.commondir, f"{BRANCH_PREFIX}{name}")
    await _rewrite_config(repo, name, None)


async def _rewrite_config(
    repo: Repo, name: str, keys: frozenset[bytes] | None
) -> None:
    """Take a branch's settings out of the config, all or some of them.

    Args:
        repo (Repo): the opened repository.
        name (str): the branch name.
        keys (frozenset[bytes] | None): the variables to take out,
            lowercase; None takes the whole block.
    """
    path = repo.location.commondir.join("config")
    data = await read_optional(repo.dispatch, path)
    if data is not None:
        dropped = without_section(data, "branch", name, keys)
        if dropped != data:
            await write_file(repo.dispatch, path, dropped)


def upstream_patterns(
    table: Mapping[str, str], known: frozenset[str], patterns: Sequence[str]
) -> list[tuple[str, bool]]:
    """What ``--forked`` and ``--delete-merged`` patterns select, resolved.

    A pattern holding a glob character stays a glob, matched as a path
    (``*`` stops at a ``/``) against an upstream's short name, case and
    ``--ignore-case`` notwithstanding; any other names a branch by git's
    rev-parse rules, its symbolic refs followed, so ``origin`` reads
    ``refs/remotes/origin/HEAD`` and ``HEAD`` the current branch.
    Pinned against git 2.56.0.

    Args:
        table (Mapping[str, str]): each ref's raw value.
        known (frozenset[str]): every name that resolves.
        patterns (Sequence[str]): the patterns as typed.

    Returns:
        list[tuple[str, bool]]: each pattern, a glob or the full ref it
        names, and whether it is a glob.

    Raises:
        GitError: a pattern names no branch.
    """
    selected: list[tuple[str, bool]] = []
    for pattern in patterns:
        if any(ch in pattern for ch in GLOB_CHARS):
            selected.append((pattern, True))
            continue
        named = next(
            iter(refs_named(known, HEAD if pattern == "@" else pattern)), None
        )
        seen: set[str] = set()
        while named is not None and named not in seen:
            seen.add(named)
            raw = table.get(named, "")
            if not raw.startswith(SYMREF_PREFIX):
                break
            named = raw[len(SYMREF_PREFIX) :].strip()
        if named is None or not named.startswith(
            (BRANCH_PREFIX, REMOTE_PREFIX)
        ):
            raise GitError(f"'{pattern}' is not a valid branch or pattern")
        selected.append((named, False))
    return selected


def selects(selected: Sequence[tuple[str, bool]], upstream: str) -> bool:
    """Whether resolved patterns select an upstream ref.

    Args:
        selected (Sequence[tuple[str, bool]]): from ``upstream_patterns``.
        upstream (str): the full upstream ref.
    """
    name = upstream
    for prefix in (BRANCH_PREFIX, REMOTE_PREFIX):
        if name.startswith(prefix):
            name = name[len(prefix) :]
            break
    return any(
        match_as_path(name, [text]) if glob else text == upstream
        for text, glob in selected
    )


def pushes_upstream(
    cfg: ConfigFile, branch: str, upstream: RefUpstream
) -> bool:
    """Whether pushing a branch to its remote would move its upstream.

    The first of the remote's push refspecs naming the branch in full
    with a destination decides where it lands, the branch's own name
    when the remote has none, and nowhere when none matches; the fetch
    refspecs then map that to a local ref (git 2.56.0).

    Args:
        cfg (ConfigFile): the repository's config.
        branch (str): the branch's short name.
        upstream (RefUpstream): its upstream.
    """
    section = (b"remote", upstream.remote.encode())
    source = f"{BRANCH_PREFIX}{branch}"
    pushed = [
        parse_refspec(v.decode()) for v in multivar(cfg, section, b"push")
    ]
    target: str | None = source
    if pushed:
        target = next(
            (
                found
                for spec in pushed
                if spec.dst and not spec.src.startswith("^")
                for found in (mapped(spec, source),)
                if found
            ),
            None,
        )
    if target is None:
        return False
    for text in multivar(cfg, section, b"fetch"):
        spec = parse_refspec(text.decode())
        if spec.src.startswith("^"):
            continue
        landed = mapped(spec, target)
        if landed:
            return landed == upstream.ref
    return False


def hash_order(names: Sequence[str]) -> list[str]:
    """The order --delete-merged deletes the names in, given in turn.

    Args:
        names (Sequence[str]): the names, in the order they went in.
    """
    size = HASH_BUCKETS
    buckets: list[list[str]] = [[] for _ in range(size)]
    for count, name in enumerate(names, start=1):
        buckets[_fnv1(name) & (size - 1)].insert(0, name)
        if count > size * HASH_LOAD // 100:
            size *= HASH_GROWTH
            grown: list[list[str]] = [[] for _ in range(size)]
            for each in (n for bucket in buckets for n in bucket):
                grown[_fnv1(each) & (size - 1)].insert(0, each)
            buckets = grown
    return [name for bucket in buckets for name in bucket]


def _fnv1(name: str) -> int:
    value = FNV_BASIS
    for byte in name.encode():
        value = (value * FNV_PRIME) & 0xFFFFFFFF
        value ^= byte
    return value


async def _delete_merged(
    repo: Repo,
    patterns: tuple[str, ...],
    operands: tuple[str, ...],
    dry_run: bool,
    quiet: bool,
) -> tuple[ByteSource | None, IOResult]:
    """Delete the branches already merged into the upstream they track.

    A local branch goes when its upstream matches a pattern, exists and
    holds the branch's tip, unless it is checked out in a worktree,
    pushing it would move that very upstream, or
    ``branch.<name>.deleteMerged`` is false, which is said on stderr. A
    branch another one not going tracks through ``.`` stays, judged
    against the first choice, and a branch that tracked one that went
    loses its upstream. Operands narrow the branches looked at, by
    their short names and case. Pinned against git 2.56.0.

    Args:
        repo (Repo): the opened repository.
        patterns (tuple[str, ...]): the ``--delete-merged`` patterns.
        operands (tuple[str, ...]): the branch patterns.
        dry_run (bool): ``--dry-run``, which only says what would go.
        quiet (bool): ``-q``.
    """
    cfg = await read_config(repo.dispatch, repo.location)
    table = ref_table(repo)
    known = known_names(table, await root_names(repo))
    selected = upstream_patterns(table, known, patterns)
    checked = await worktree_heads(repo)
    branches = sorted(name for name in table if name.startswith(BRANCH_PREFIX))
    ups = {
        ref: tracking_ref(cfg, ref[len(BRANCH_PREFIX) :], known)
        for ref in branches
    }
    skipped = ""
    chosen: list[str] = []
    for ref in branches:
        name, up = ref[len(BRANCH_PREFIX) :], ups[ref]
        tip, _ = resolve_ref(table, ref)
        if (
            tip is None
            or up is None
            or ref in checked
            or not match_short(ref, operands)
            or not selects(selected, up.ref)
        ):
            continue
        there, _ = resolve_ref(table, up.ref)
        if there is None or pushes_upstream(cfg, name, up):
            continue
        if not await asyncio.to_thread(
            _merged, repo, tip.encode(), there.encode()
        ):
            continue
        wanted = git_bool(
            multivar(cfg, (b"branch", name.encode()), b"deletemerged"),
            f"branch.{name}.deletemerged",
            True,
        )
        if not wanted:
            skipped += (
                f"Skipping '{name}' (branch.{name}.deleteMerged is false)\n"
            )
            continue
        chosen.append(ref)
    held = {
        up.ref
        for ref, up in ups.items()
        if up is not None and up.remote == LOCAL_REMOTE and ref not in chosen
    }
    going = [ref for ref in chosen if ref not in held]
    out = ""
    width = abbrev_for(repo)
    for name in hash_order([ref[len(BRANCH_PREFIX) :] for ref in going]):
        tip, target = resolve_ref(table, f"{BRANCH_PREFIX}{name}")
        was = (
            target
            if target is not None
            else short((tip or "").encode(), width)
        )
        if dry_run:
            out += f"Would delete branch {name} (was {was}).\n"
            continue
        await _drop(repo, name)
        out += f"Deleted branch {name} (was {was}).\n"
    if not dry_run:
        for ref, up in ups.items():
            if (
                up is not None
                and up.remote == LOCAL_REMOTE
                and up.ref in going
                and ref not in going
            ):
                await _rewrite_config(
                    repo, ref[len(BRANCH_PREFIX) :], UPSTREAM_KEYS
                )
    if quiet:
        return None, IOResult()
    return out.encode() or None, IOResult(stderr=skipped.encode() or None)


# What a listing row reads when the line gives no --format.
ROW_ID = parse_field("objectname:short")
ROW_SUBJECT = parse_field("contents:subject")
ROW_TRACK = parse_field("upstream:track")
ROW_UPSTREAM = parse_field("upstream:short")
ROW_WORKTREE = parse_field("worktreepath")
ROW_TARGET = parse_field("symref:short")


def row_fields(verbose: int) -> tuple[RefField, ...]:
    """The fields ``branch`` rows read with ``verbose`` ``-v``.

    Args:
        verbose (int): how many ``-v``.
    """
    if not verbose:
        return ROW_WORKTREE, ROW_TARGET
    return (
        ROW_WORKTREE,
        ROW_TARGET,
        ROW_ID,
        ROW_SUBJECT,
        ROW_TRACK,
        *((ROW_UPSTREAM,) if verbose > 1 else ()),
    )


def _row_label(item: RefItem, ctx: RefContext, prefix: str) -> str:
    """A row's name: ``main``, ``remotes/origin/main`` (``origin/main``
    under ``-r``), or the detached HEAD's description.

    Args:
        item (RefItem): the listed ref.
        ctx (RefContext): carries the detached HEAD's description.
        prefix (str): what a remote-tracking branch is labelled with.
    """
    if item.kind is RefKind.DETACHED:
        return ctx.head_description
    if item.kind is RefKind.REMOTE:
        return prefix + item.name.removeprefix(REMOTE_PREFIX)
    return item.name.removeprefix(BRANCH_PREFIX)


def _tracking(item: RefItem, table: ValueTable, verbose: int) -> str:
    """The upstream bracket of a verbose row, with its trailing space.

    git 2.50.1 prints ``[ahead 1, behind 2]`` or ``[gone]`` under ``-v``
    and nothing for a branch level with its upstream; ``-vv`` names the
    upstream first, ``[origin/main: ahead 1]``, ``[origin/main]``.

    Args:
        item (RefItem): the listed ref.
        table (ValueTable): the listing's field values.
        verbose (int): how many ``-v``.
    """
    upstream = item.upstream
    if item.kind is not RefKind.BRANCH or upstream is None:
        return ""
    if upstream.gone:
        state = "gone"
    else:
        counts = [
            f"{word} {count}"
            for word, count in (
                ("ahead", upstream.ahead),
                ("behind", upstream.behind),
            )
            if count
        ]
        state = ", ".join(counts)
    if verbose == 1:
        return f"[{state}] " if state else ""
    name = table.value(item, ROW_UPSTREAM).text
    return f"[{name}: {state}] " if state else f"[{name}] "


def branch_rows(
    items: list[RefItem],
    ctx: RefContext,
    keys: tuple[RefSortKey, ...] | None,
    verbose: int,
    prefix: str,
    icase: bool,
) -> tuple[str, GitError | None]:
    """A branch listing as git prints it when the line gives no
    ``--format``.

    Each row is two columns of marker, ``*`` for the branch HEAD is on
    (or a detached HEAD) and ``+`` for one another worktree has out,
    then the name; a symbolic ref adds `` -> `` and its target. ``-v``
    pads every name to the widest, by display width, and follows it with
    the abbreviated id, the upstream bracket and the subject, so an
    empty subject leaves the id's space behind. A remote-tracking
    symbolic ref keeps only its `` -> `` target there, while a local one
    reads as the branch it names. ``-vv`` also names the upstream, and
    puts ``(<path>)`` after the id of a branch another worktree has out.

    Args:
        items (list[RefItem]): the listed refs, in name order.
        ctx (RefContext): the listing's facts.
        keys (tuple[RefSortKey, ...] | None): the sort keys, None for
            ``--no-sort``.
        verbose (int): how many ``-v``.
        prefix (str): what a remote-tracking branch is labelled with,
            ``remotes/`` unless only those are listed.
        icase (bool): ``--ignore-case``.
    """
    table = ValueTable(
        (*row_fields(verbose), *(key.field for key in keys or ())), ctx
    )
    rows: list[str] = []
    try:
        ordered = (
            sort_refs(items, keys, table, ctx, icase, detached_first=True)
            if keys
            else list(items)
        )
        labels = [_row_label(item, ctx, prefix) for item in ordered]
        width = max(map(display_width, labels), default=0)
        for item, label in zip(ordered, labels, strict=True):
            current = item.kind is RefKind.DETACHED or item.name == ctx.head
            elsewhere = item.kind is RefKind.BRANCH and bool(item.worktree)
            marker = "* " if current else "+ " if elsewhere else "  "
            target = table.value(item, ROW_TARGET).text if item.symref else ""
            if not verbose:
                arrow = f" -> {target}" if target else ""
                rows.append(f"{marker}{label}{arrow}\n")
                continue
            padded = label + " " * (width - display_width(label))
            if target and item.kind is RefKind.REMOTE:
                rows.append(f"{marker}{padded} -> {target}\n")
                continue
            where = (
                f"({item.worktree}) "
                if verbose > 1 and elsewhere and not current
                else ""
            )
            rows.append(
                f"{marker}{padded} {table.value(item, ROW_ID).text} {where}"
                f"{_tracking(item, table, verbose)}"
                f"{table.value(item, ROW_SUBJECT).text}\n"
            )
    except GitError as exc:
        return "".join(rows), exc
    return "".join(rows), None


async def _list_branches(
    ctx: Context,
    fl: FlagView,
    repo: Repo,
    head: HeadRef,
    patterns: tuple[str, ...],
    filt: RefFilter | None,
    remotes_only: bool,
    include_remotes: bool,
    forked: tuple[str, ...],
) -> tuple[ByteSource | None, IOResult]:
    """A branch listing, through git's ref-filter as git prints one.

    The local branches (``-r`` the remote-tracking ones instead, ``-a``
    both) and a detached HEAD, which leads whatever the sort keys say,
    each printed through ``--format`` or as ``branch_rows`` lays rows
    out. ``--forked`` keeps the local branches whose upstream it
    selects (see ``upstream_patterns``).

    Args:
        ctx (Context): the line's context, for its env.
        fl (FlagView): spec-bound options.
        repo (Repo): the opened repository.
        head (HeadRef): what HEAD points at.
        patterns (tuple[str, ...]): the name patterns, empty for all.
        filt (RefFilter | None): the resolved ref filter.
        remotes_only (bool): ``-r``.
        include_remotes (bool): ``-r`` or ``-a``.
        forked (tuple[str, ...]): the ``--forked`` patterns.
    """
    cfg = await read_config(repo.dispatch, repo.location)
    followers: frozenset[str] | None = None
    if forked:
        table = ref_table(repo)
        known = known_names(table, await root_names(repo))
        selected = upstream_patterns(table, known, forked)
        followers = frozenset(
            ref
            for ref in table
            if ref.startswith(BRANCH_PREFIX)
            for up in (tracking_ref(cfg, ref[len(BRANCH_PREFIX) :], known),)
            if up is not None and selects(selected, up.ref)
        )
    keys = sort_keys(fl, configured_sort(cfg, b"branch"))
    icase = fl.as_bool("ignore_case")
    verbose = fl.as_int("verbose") or 0
    prefix = "" if remotes_only else REMOTE
    template = fl.as_str("format")
    detached = head.commit is not None and not remotes_only

    def wanted(name: str) -> bool:
        kind = (
            (name == HEAD and detached)
            or (not remotes_only and name.startswith(BRANCH_PREFIX))
            or (include_remotes and name.startswith(REMOTE_PREFIX))
        )
        return (
            kind
            and match_short(name, patterns, icase)
            and (followers is None or name in followers)
        )

    fmt = listing_format(template) if template is not None else None
    items, ref_ctx, errors = await ref_listing(
        repo,
        cfg,
        used_fields(fmt, keys or ())
        if fmt is not None
        else (*row_fields(verbose), *(key.field for key in keys or ())),
        wanted,
        filt,
        date_clock(ctx.env),
    )
    if any(item.kind is RefKind.DETACHED for item in items):
        ref_ctx = replace(
            ref_ctx,
            head_description=await head_description(repo, head),
        )
    if fmt is None:
        out, stopped = branch_rows(
            items, ref_ctx, keys, verbose, prefix, icase
        )
    else:
        out, stopped = format_refs(
            fmt,
            items,
            ref_ctx,
            keys,
            omit_empty=fl.as_bool("omit_empty"),
            icase=icase,
            detached_first=True,
            stream=False,
        )
    return listing_result(out, errors, stopped)


async def branch(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """List, create or delete branches.

    A name operand creates a branch, ``-d`` deletes one, and neither
    lists them with the checked-out one marked. ``-d`` deletes only a
    branch HEAD already contains, and ``-D`` deletes one regardless,
    which is git's own split and the reason both are here: without
    ``-D`` there is nothing ``-d`` can refuse to do. ``-r`` lists
    remote-tracking branches instead of local ones and ``-a`` lists
    both; local names sort together and remotes follow.

    ``-l`` and the ref filters (``--contains``, ``--merged``,
    ``--points-at`` and their negations) make the line a listing whose
    operands are name patterns, so ``git branch --contains side topic``
    lists ``topic`` if it holds ``side`` rather than creating anything,
    and a line that also deletes names two modes, which git answers
    with its usage. ``--forked`` lists too, and ``--delete-merged`` is
    a mode of its own whose operands narrow the branches it looks at;
    ``--dry-run`` belongs to it alone.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the operands.
        ctx (Context): the line's context; git reads its repository
            through ``ctx.vfs``.
    """
    vfs = require_vfs(ctx)
    words = filter_words(ctx)
    operands = without_filter_values(texts, words)
    flags = ctx.flags
    fl = FlagView(flags)
    remotes_only = fl.as_bool("r")
    include_remotes = remotes_only or fl.as_bool("a")
    forked = tuple(fl.as_list("forked"))
    merged = tuple(fl.as_list("delete_merged"))
    dry_run = fl.typed_order("dry_run", "no_dry_run")[-1:] == ["dry_run"]
    listing = bool(words) or fl.as_bool("list") or bool(forked)
    check_switches(ctx, operands)
    repo, location = await opened(ctx, fl)
    if dry_run and not merged:
        raise GitError("--dry-run requires --delete-merged")
    if merged:
        if (
            listing
            or fl.as_bool("delete")
            or fl.as_bool("D")
            or fl.as_bool("show_current")
        ):
            raise UsageError("", verb_usage(ctx))
        return await _delete_merged(
            repo, merged, tuple(operands), dry_run, fl.as_bool("quiet")
        )
    mode = await track_mode(repo)
    filt = await asyncio.to_thread(ref_filter, repo, words)
    head = await read_head(vfs, location.gitdir)
    force = fl.as_bool("D")
    if fl.as_bool("show_current"):
        if listing or force or fl.as_bool("delete"):
            raise UsageError("", verb_usage(ctx))
        return (
            (head.branch + "\n").encode() if head.branch else b""
        ), IOResult()
    if fl.as_bool("delete") or force:
        if listing:
            raise UsageError("", verb_usage(ctx))
        if not operands:
            raise BranchNameRequiredError()
        deleted = b"".join(
            [await _delete(repo, head, name, force) for name in operands]
        )
        if fl.as_bool("quiet"):
            return None, IOResult()
        return deleted, IOResult()
    if operands and not listing:
        tracking, warning = await _create(
            repo,
            operands[0],
            operands[1] if len(operands) > 1 else None,
            mode,
            head,
        )
        return (
            tracking.encode()
            if tracking and not fl.as_bool("quiet")
            else None,
            IOResult(stderr=warning.encode()),
        )
    return await _list_branches(
        ctx,
        fl,
        repo,
        head,
        operands if listing else (),
        filt,
        remotes_only,
        include_remotes,
        forked,
    )


def upstream_of(
    repo: BaseRepo, cfg: ConfigFile, branch: str, tip: ObjectID
) -> Upstream | None:
    """A branch's upstream from ``branch.<name>.remote`` and ``.merge``.

    Args:
        repo (BaseRepo): the opened repository.
        cfg (ConfigFile): its config.
        branch (str): the branch's short name.
        tip (ObjectID): the commit the branch holds.
    """
    section = (b"branch", branch.encode())
    values = dict(cfg.items(section)) if cfg.has_section(section) else {}
    remote, merge = values.get(b"remote"), values.get(b"merge")
    if remote is None or merge is None:
        return None
    tracked = merge
    if remote != b".":
        tracked = (
            REMOTE_PREFIX.encode()
            + remote
            + b"/"
            + merge.removeprefix(BRANCH_PREFIX.encode())
        )
    label = (
        tracked.removeprefix(BRANCH_PREFIX.encode())
        .removeprefix(REMOTE_PREFIX.encode())
        .decode()
    )
    if Ref(tracked) not in repo.refs.allkeys():
        return Upstream(label, 0, 0, True)
    ours = reached(repo, tip)
    theirs = reached(repo, repo.refs[Ref(tracked)])
    return Upstream(label, len(ours - theirs), len(theirs - ours), False)


async def branch_upstream(
    repo: Repo, head: HeadRef, no_commits: bool
) -> Upstream | None:
    """The current branch's upstream, None when it has none or no commits.

    Args:
        repo (Repo): the opened repository.
        head (HeadRef): what HEAD points at.
        no_commits (bool): whether the branch is still unborn.
    """
    if head.branch is None or no_commits:
        return None
    cfg = await read_config(repo.dispatch, repo.location)
    ref = Ref(f"{BRANCH_PREFIX}{head.branch}".encode())
    if (
        not cfg.has_section((b"branch", head.branch.encode()))
        or ref not in repo.refs.allkeys()
    ):
        return None
    return await asyncio.to_thread(
        upstream_of, repo, cfg, head.branch, ObjectID(repo.refs[ref])
    )


def branch_read_only(
    texts: list[str], ctx: Context, location: RepoLocation | None
) -> GitError:
    """branch's refusal by a read-only mount: the lock on the ref it
    creates or deletes.

    Args:
        texts (list[str]): the line's operands.
        ctx (Context): the line's context.
        location (RepoLocation | None): the repository it opened.
    """
    fl = FlagView(ctx.flags)
    ref = f"{BRANCH_PREFIX}{texts[0] if texts else ''}"
    root = location.commondir.virtual if location is not None else ".git"
    path = posixpath.join(root, ref)
    if fl.as_bool("delete") or fl.as_bool("D"):
        return RefDeleteReadOnlyError(ref, path)
    return RefReadOnlyError(ref, path)
