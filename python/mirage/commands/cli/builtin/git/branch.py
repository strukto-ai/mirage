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
from dataclasses import replace
from io import BytesIO

from dulwich.config import ConfigFile
from dulwich.objects import Commit, ObjectID
from dulwich.refs import Ref
from dulwich.repo import BaseRepo
from dulwich.walk import Walker

from mirage.commands.cli.builtin.git.constants import DWIM_RULES, HEAD
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
    NoWorkspaceError,
    RefDeleteReadOnlyError,
    RefLockError,
    RefReadOnlyError,
    UnmergedBranchError,
    UsageError,
)
from mirage.commands.cli.builtin.git.format import short
from mirage.commands.cli.builtin.git.io import read_optional, write_file
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.ref_filter import (
    RefFilter,
    filter_words,
    ref_filter,
    without_filter_values,
)
from mirage.commands.cli.builtin.git.ref_format import (
    display_width,
    format_refs,
    listing_format,
    used_fields,
)
from mirage.commands.cli.builtin.git.ref_list import (
    configured_sort,
    head_description,
    listing_result,
    match_short,
    read_config,
    ref_listing,
    sort_keys,
)
from mirage.commands.cli.builtin.git.reflog import (
    IDENTITY,
    ZERO,
    append,
    entry,
    logged,
)
from mirage.commands.cli.builtin.git.refs import (
    blocking_ref,
    delete_ref,
    read_head,
    valid_ref_name,
    write_ref,
)
from mirage.commands.cli.builtin.git.repo import config_bool, config_values
from mirage.commands.cli.builtin.git.revparse import (
    note_ambiguity,
    refs_named,
    resolve_object,
    unwrapped,
)
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import (
    HeadRef,
    RefItem,
    RefKind,
    RepoLocation,
    Track,
    Upstream,
)
from mirage.commands.cli.builtin.git.util import (
    check_switches,
    config_section,
    fatal,
    git_bool,
    multivar,
    verb_usage,
    without_section,
)
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.runtime.types import DispatchFn

HEADS_PREFIX = b"refs/heads/"
REMOTES_PREFIX = b"refs/remotes/"
REMOTE = "remotes/"
AUTO_SETUP_MERGE = "branch.autosetupmerge"
TRACK_WORDS = (Track.ALWAYS, Track.SIMPLE, Track.INHERIT)


async def refuse_ambiguous(
    dispatch: DispatchFn,
    location: RepoLocation,
    repo: BaseRepo,
    name: str,
    warned: bool,
) -> None:
    """Refuse a start point two refs answer to.

    As git's branch creation does while ``core.warnAmbiguousRefs`` is
    on, after warning that it is ambiguous. With no start point git
    starts from the current branch by its short name, so that name is
    the one checked.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        location (RepoLocation): the discovered repository.
        repo (BaseRepo): the opened repository.
        name (str): the start point as typed, or the current branch's
            short name.
        warned (bool): whether reading it already put the warning on
            the list.

    Raises:
        AmbiguousObjectNameError: two refs answer to the name.
    """
    if not await config_bool(
        dispatch, location, b"core", b"warnambiguousrefs", True
    ):
        return
    known = (ref.decode(errors="replace") for ref in repo.refs.allkeys())
    if len(refs_named(known, name)) <= 1:
        return
    if not warned:
        note_ambiguity(repo, name)
    raise AmbiguousObjectNameError(name)


async def _create(
    dispatch: DispatchFn,
    repo: BaseRepo,
    location: RepoLocation,
    name: str,
    start: str | None,
    mode: Track,
    head: HeadRef,
) -> tuple[str, str]:
    """Point a new branch at a commit, refusing to move an existing one.

    Returns what git prints about the upstream it set up, on stdout and
    on stderr.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        repo (BaseRepo): the opened repository.
        location (RepoLocation): the discovered repository.
        name (str): the branch name.
        start (str | None): the revision to start it at, HEAD when None.
        mode (Track): ``branch.autoSetupMerge``.
        head (HeadRef): what HEAD points at.
    """
    # Before the start point resolves, which is git's order here and
    # the opposite of switch's. A ref is a path below .git, so an
    # unchecked name reaches write_ref as one.
    if not valid_ref_name(name):
        raise InvalidBranchNameError(name)
    ref = f"{HEADS_PREFIX.decode()}{name}"
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
    await refuse_ambiguous(dispatch, location, repo, origin, True)
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
    await write_ref(dispatch, location.commondir, ref, commit.id)
    log = posixpath.join(location.commondir, "logs", ref)
    if await logged(dispatch, location, ref, log):
        line = entry(
            ZERO,
            commit.id,
            IDENTITY,
            int(time.time()),
            f"branch: Created from {origin}",
        )
        await append(dispatch, location.commondir, f"logs/{ref}", line)
    return await set_up_tracking(
        dispatch, repo, location, name, start, mode, head
    )


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
        if ref.startswith(REMOTES_PREFIX)
        and ref.endswith(f"/{name}".encode())
        and ref.count(b"/") == 3 + name.count("/")
    ]
    return found[0] if len(found) == 1 else None


async def track_mode(dispatch: DispatchFn, location: RepoLocation) -> Track:
    """``branch.autoSetupMerge`` from the repository's config.

    The words are case-sensitive and anything else reads as a boolean,
    so ``never`` or ``Always`` is a bad boolean. git reads the variable
    before any command runs, so a verb that can create a branch reads it
    first and fails with nothing written (pinned against git 2.50.1).

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        location (RepoLocation): the discovered repository.

    Raises:
        BadConfigValueError: a value that is neither a word nor a boolean.
    """
    mode = Track.REMOTE
    for value in await config_values(
        dispatch, location, b"branch", b"autosetupmerge"
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
    if ref.startswith(HEADS_PREFIX.decode()):
        source = ref[len(HEADS_PREFIX) :]
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
    if not ref.startswith(REMOTES_PREFIX.decode()):
        return None, [], "", ""
    remote, _, name = ref[len(REMOTES_PREFIX) :].partition("/")
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
    return remote, [f"{HEADS_PREFIX.decode()}{name}"], f"{remote}/", ""


async def set_up_tracking(
    dispatch: DispatchFn,
    repo: BaseRepo,
    location: RepoLocation,
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
        dispatch (DispatchFn): workspace op dispatcher.
        repo (BaseRepo): the opened repository.
        location (RepoLocation): the discovered repository.
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
        known = repo.refs.allkeys()
        ref = next(
            (
                rule.format(typed)
                for rule in DWIM_RULES
                if Ref(rule.format(typed).encode()) in known
            ),
            None,
        )
    if ref is None:
        return "", ""
    path = f"{location.commondir}/config"
    data = await read_optional(dispatch, path) or b""
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
    await write_file(dispatch, path, data + section.encode())
    labels = [
        f"{prefix}{merge.removeprefix(HEADS_PREFIX.decode())}"
        for merge in merges
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
    dispatch: DispatchFn,
    repo: BaseRepo,
    location: RepoLocation,
    head: HeadRef,
    name: str,
    force: bool,
) -> bytes:
    """Remove a branch, refusing when the removal would lose commits.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        repo (BaseRepo): the opened repository.
        location (RepoLocation): the discovered repository.
        head (HeadRef): what HEAD points at.
        name (str): the branch name.
        force (bool): whether ``-D`` was given, which deletes a branch
            HEAD does not contain.
    """
    ref = Ref(f"{HEADS_PREFIX.decode()}{name}".encode())
    if ref not in repo.refs.allkeys():
        raise NoBranchError(name)
    if name == head.branch:
        raise CheckedOutBranchError(name, location.worktree)
    sha = repo.refs[ref]
    if not force and not await asyncio.to_thread(
        _merged, repo, sha, head_commit(repo, head)
    ):
        raise UnmergedBranchError(name)
    await delete_ref(dispatch, location.commondir, ref.decode())
    path = f"{location.commondir}/config"
    data = await read_optional(dispatch, path)
    if data is not None:
        dropped = without_section(data, "branch", name)
        if dropped != data:
            await write_file(dispatch, path, dropped)
    return (
        f"Deleted branch {name} (was {short(sha, abbrev_for(repo))}).\n"
    ).encode()


def build_format(verbose: int, width: int, prefix: str) -> str:
    """git's ``build_format``: the format a branch listing prints with
    when the line gives none, colors left out as they are off a
    terminal.

    A local branch is marked ``*`` when HEAD is on it and ``+`` when
    another worktree is; ``-v`` pads every name to one column and adds
    the id, the upstream's distance and the subject, and ``-vv`` names
    the upstream (and a worktree the branch is out in) as well.

    Args:
        verbose (int): how many ``-v``.
        width (int): the name column, from ``list_width``.
        prefix (str): what a remote-tracking branch is labelled with,
            ``remotes/`` unless only those are listed.
    """
    label = prefix.replace("%", "%%")
    local = (
        "%(if)%(HEAD)%(then)* %(else)%(if)%(worktreepath)%(then)+ "
        "%(else)  %(end)%(end)"
    )
    remote = "  "
    if verbose:
        oid = "%(objectname:short)"
        local += f"%(align:{width},left)%(refname:lstrip=2)%(end) {oid} "
        if verbose > 1:
            local += (
                "%(if:notequals=*)%(HEAD)%(then)%(if)%(worktreepath)"
                "%(then)(%(worktreepath)) %(end)%(end)"
                "%(if)%(upstream)%(then)[%(upstream:short)"
                "%(if)%(upstream:track)%(then): "
                "%(upstream:track,nobracket)%(end)] %(end)"
                "%(contents:subject)"
            )
        else:
            local += (
                "%(if)%(upstream:track)%(then)%(upstream:track) "
                "%(end)%(contents:subject)"
            )
        remote += (
            f"%(align:{width},left){label}%(refname:lstrip=2)%(end)"
            "%(if)%(symref)%(then) -> %(symref:short)"
            f"%(else) {oid} %(contents:subject)%(end)"
        )
    else:
        local += (
            "%(refname:lstrip=2)%(if)%(symref)%(then) -> %(symref:short)%(end)"
        )
        remote += (
            f"{label}%(refname:lstrip=2)%(if)%(symref)%(then) -> "
            "%(symref:short)%(end)"
        )
    return (
        f"%(if:notequals=refs/remotes)%(refname:rstrip=-2)%(then)"
        f"{local}%(else){remote}%(end)"
    )


def list_width(items: list[RefItem], bonus: int, description: str) -> int:
    """``calc_maxwidth``: the widest name a verbose listing pads to.

    Args:
        items (list[RefItem]): the listed refs.
        bonus (int): the width of the label a remote-tracking branch
            carries.
        description (str): the detached HEAD row's name.
    """
    widest = 0
    for item in items:
        if item.kind is RefKind.DETACHED:
            width = display_width(description)
        else:
            name = item.name
            for prefix in (HEADS_PREFIX, REMOTES_PREFIX):
                name = name.removeprefix(prefix.decode())
            width = display_width(name) + (
                bonus if item.kind is RefKind.REMOTE else 0
            )
        widest = max(widest, width)
    return widest


async def _list_branches(
    inv: CLIInvocation[None],
    fl: FlagView,
    dispatch: DispatchFn,
    repo: BaseRepo,
    location: RepoLocation,
    head: HeadRef,
    patterns: tuple[str, ...],
    filt: RefFilter | None,
    remotes_only: bool,
    include_remotes: bool,
) -> tuple[ByteSource | None, IOResult]:
    """A branch listing, through git's ref-filter as git prints one.

    The local branches (``-r`` the remote-tracking ones instead, ``-a``
    both) and a detached HEAD, which leads whatever the sort keys say,
    each printed through ``--format`` or the format ``build_format``
    makes.

    Args:
        inv (CLIInvocation[None]): the line's invocation record.
        fl (FlagView): spec-bound options.
        dispatch (DispatchFn): workspace op dispatcher.
        repo (BaseRepo): the opened repository.
        location (RepoLocation): the discovered repository.
        head (HeadRef): what HEAD points at.
        patterns (tuple[str, ...]): the name patterns, empty for all.
        filt (RefFilter | None): the resolved ref filter.
        remotes_only (bool): ``-r``.
        include_remotes (bool): ``-r`` or ``-a``.
    """
    cfg = await read_config(dispatch, location)
    keys = sort_keys(fl, configured_sort(cfg, b"branch"))
    icase = fl.as_bool("ignore_case")
    verbose = fl.as_int("verbose") or 0
    prefix = "" if remotes_only else REMOTE
    template = fl.as_str("format")
    detached = head.commit is not None and not remotes_only

    def wanted(name: str) -> bool:
        kind = (
            (name == HEAD and detached)
            or (not remotes_only and name.startswith("refs/heads/"))
            or (include_remotes and name.startswith("refs/remotes/"))
        )
        return kind and match_short(name, patterns, icase)

    fmt = listing_format(
        template if template is not None else build_format(verbose, 0, prefix)
    )
    items, ctx, errors = await ref_listing(
        dispatch,
        repo,
        location,
        cfg,
        used_fields(fmt, keys or ()),
        wanted,
        filt,
        date_clock(inv.env),
    )
    if any(item.kind is RefKind.DETACHED for item in items):
        ctx = replace(
            ctx,
            head_description=await head_description(
                dispatch, repo, location, head
            ),
        )
    if template is None and verbose:
        fmt = listing_format(
            build_format(
                verbose,
                list_width(items, len(prefix), ctx.head_description),
                prefix,
            )
        )
    out, stopped = format_refs(
        fmt,
        items,
        ctx,
        keys,
        omit_empty=fl.as_bool("omit_empty"),
        icase=icase,
        detached_first=True,
        stream=False,
    )
    return listing_result(out, errors, stopped)


async def branch(
    inv: CLIInvocation[None],
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
    with its usage.

    Args:
        inv (CLIInvocation[None]): the line's invocation record.
            git declares no config_model; the planes it reads
            (data through ``dispatch``, names through ``ns``) ride
            ``inv.doors``.
    """
    doors = inv.doors or CLIDoors()
    dispatch = doors.dispatch
    words = filter_words(inv)
    texts = without_filter_values(inv.texts, words)
    flags = inv.flags
    fl = FlagView(flags)
    remotes_only = fl.as_bool("r")
    include_remotes = remotes_only or fl.as_bool("a")
    listing = bool(words) or fl.as_bool("list")
    try:
        if dispatch is None:
            raise NoWorkspaceError()
        check_switches(inv, texts)
        repo, location = await opened(fl, doors)
        mode = await track_mode(dispatch, location)
        filt = await asyncio.to_thread(ref_filter, repo, words)
        head = await read_head(dispatch, location.gitdir)
        if fl.as_bool("show_current"):
            return (
                (head.branch + "\n").encode() if head.branch else b""
            ), IOResult()
        force = fl.as_bool("D")
        if fl.as_bool("delete") or force:
            if listing:
                raise UsageError("", verb_usage(inv))
            if not texts:
                raise BranchNameRequiredError()
            deleted = b"".join(
                [
                    await _delete(dispatch, repo, location, head, name, force)
                    for name in texts
                ]
            )
            if fl.as_bool("quiet"):
                return None, IOResult()
            return yield_bytes(deleted), IOResult()
        if texts and not listing:
            tracking, warning = await _create(
                dispatch,
                repo,
                location,
                texts[0],
                texts[1] if len(texts) > 1 else None,
                mode,
                head,
            )
            return (
                yield_bytes(tracking.encode())
                if tracking and not fl.as_bool("quiet")
                else None,
                IOResult(stderr=warning.encode()),
            )
        return await _list_branches(
            inv,
            fl,
            dispatch,
            repo,
            location,
            head,
            texts if listing else (),
            filt,
            remotes_only,
            include_remotes,
        )
    except GitError as exc:
        return fatal(exc)


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
            REMOTES_PREFIX + remote + b"/" + merge.removeprefix(HEADS_PREFIX)
        )
    label = (
        tracked.removeprefix(HEADS_PREFIX)
        .removeprefix(REMOTES_PREFIX)
        .decode()
    )
    if Ref(tracked) not in repo.refs.allkeys():
        return Upstream(label, 0, 0, True)
    ours = {e.commit.id for e in Walker(repo.object_store, [tip])}
    theirs = {
        e.commit.id
        for e in Walker(repo.object_store, [repo.refs[Ref(tracked)]])
    }
    return Upstream(label, len(ours - theirs), len(theirs - ours), False)


async def branch_upstream(
    dispatch: DispatchFn,
    repo: BaseRepo,
    location: RepoLocation,
    head: HeadRef,
    no_commits: bool,
) -> Upstream | None:
    """The current branch's upstream, None when it has none or no commits.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        repo (BaseRepo): the opened repository.
        location (RepoLocation): the discovered repository.
        head (HeadRef): what HEAD points at.
        no_commits (bool): whether the branch is still unborn.
    """
    if head.branch is None or no_commits:
        return None
    data = await read_optional(dispatch, f"{location.commondir}/config")
    cfg = ConfigFile.from_file(BytesIO(data or b""))
    ref = Ref(f"refs/heads/{head.branch}".encode())
    if (
        not cfg.has_section((b"branch", head.branch.encode()))
        or ref not in repo.refs.allkeys()
    ):
        return None
    return await asyncio.to_thread(
        upstream_of, repo, cfg, head.branch, ObjectID(repo.refs[ref])
    )


def branch_read_only(
    inv: CLIInvocation[None], location: RepoLocation | None
) -> GitError:
    """branch's refusal by a read-only mount: the lock on the ref it
    creates or deletes.

    Args:
        inv (CLIInvocation[None]): the line's invocation record.
        location (RepoLocation | None): the repository it opened.
    """
    fl = FlagView(inv.flags)
    ref = f"{HEADS_PREFIX.decode()}{inv.texts[0] if inv.texts else ''}"
    root = location.commondir if location is not None else ".git"
    path = posixpath.join(root, ref)
    if fl.as_bool("delete") or fl.as_bool("D"):
        return RefDeleteReadOnlyError(ref, path)
    return RefReadOnlyError(ref, path)
