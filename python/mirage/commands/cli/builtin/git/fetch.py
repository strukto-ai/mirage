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
from dataclasses import dataclass, replace
from io import BytesIO

from dulwich.config import ConfigFile
from dulwich.objects import Commit, ObjectID
from dulwich.refs import Ref
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.constants import DWIM_RULES
from mirage.commands.cli.builtin.git.discover import is_bare
from mirage.commands.cli.builtin.git.errors import (
    FetchHeadReadOnlyError,
    GitError,
    MissingRepositoryError,
    NoWorkspaceError,
)
from mirage.commands.cli.builtin.git.inspect import global_sources
from mirage.commands.cli.builtin.git.io import read_optional, write_file
from mirage.commands.cli.builtin.git.objects import abbrev_for, store_pack
from mirage.commands.cli.builtin.git.reflog import (
    IDENTITY,
    ZERO,
    append,
    entry,
)
from mirage.commands.cli.builtin.git.refs import (
    delete_ref,
    mapped,
    parse_refspec,
    read_head,
    valid_ref_name,
    write_ref,
)
from mirage.commands.cli.builtin.git.repo import open_repo
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.transport import (
    Advertisement,
    HttpTransport,
    LocalTransport,
    display_url,
    extra_headers,
    open_transport,
)
from mirage.commands.cli.builtin.git.types import Refspec, RepoLocation
from mirage.commands.cli.builtin.git.util import (
    check_switches,
    fatal,
    multivar,
)
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.runtime.types import DispatchFn

HEADS = "refs/heads/"
TAGS = "refs/tags/"
REMOTES = "refs/remotes/"
FETCH_HEAD = "FETCH_HEAD"
ALL_TAGS = "refs/tags/*:refs/tags/*"
TERM_COLUMNS = 80
REFCOL_MIN = 10
UNREACHABLE = (
    "fatal: Could not read from remote repository.\n\n"
    "Please make sure you have the correct access rights\n"
    "and the repository exists."
)
NO_REMOTE = (
    "No remote repository specified.  Please, specify either a URL "
    "or a\nremote name from which new revisions should be fetched."
)


@dataclass(frozen=True, slots=True)
class Wanted:
    """One remote ref a fetch takes, and where it lands.

    Args:
        remote (str): the remote ref name, ``HEAD`` for a bare URL.
        oid (str): the object id the remote holds there.
        local (str | None): the local ref to update, None when it only
            goes to FETCH_HEAD.
        force (bool): whether a non-fast-forward is allowed.
        merge (bool): whether FETCH_HEAD marks it for merging.
        listed (bool): whether it is written to FETCH_HEAD at all.
    """

    remote: str
    oid: str
    local: str | None
    force: bool = False
    merge: bool = False
    listed: bool = True


@dataclass(frozen=True, slots=True)
class Row:
    """One line of git's fetch summary.

    Args:
        code (str): the flag column: ``*`` new, `` `` fast-forward,
            ``+`` forced, ``-`` pruned, ``!`` rejected, ``=`` unchanged.
        summary (str): ``[new branch]``, ``a..b`` and the like.
        remote (str): the remote ref, prettified.
        local (str): the local ref, prettified, or FETCH_HEAD.
        error (str): the parenthesized note, empty for none.
        counted (bool): whether the row widens the ref column, as
            git's refcol_width counts a changed local ref only.
    """

    code: str
    summary: str
    remote: str
    local: str
    error: str = ""
    counted: bool = False


def prettify(ref: str) -> str:
    """A ref name the way git's fetch summary shortens it.

    Args:
        ref (str): the full ref name.
    """
    for prefix in (HEADS, TAGS, REMOTES):
        if ref.startswith(prefix):
            return ref[len(prefix) :]
    return ref


def summary_lines(url: str, rows: list[Row], abbrev: int) -> str:
    """The ``From <url>`` block git prints to stderr after a fetch.

    Pinned against git 2.47.3 and 2.50.1: the summary column is
    ``2 * abbrev + 3`` wide and the ref column at least ten, widened by
    each changed ref whose line still fits 80 columns.

    Args:
        url (str): the remote URL, as displayed.
        rows (list[Row]): the lines, in order.
        abbrev (int): the repository's abbreviated id length.
    """
    if not rows:
        return ""
    width = 2 * abbrev + 3
    refcol = REFCOL_MIN
    for row in rows:
        if (
            row.counted
            and 21 + len(row.remote) + 4 + len(row.local) < TERM_COLUMNS
        ):
            refcol = max(refcol, len(row.remote))
    lines = [f"From {display_url(url)}\n"]
    for row in rows:
        note = f"  ({row.error})" if row.error else ""
        lines.append(
            f" {row.code} {row.summary:<{width}} "
            f"{row.remote:<{refcol}} -> {row.local}{note}\n"
        )
    return "".join(lines)


def _is_ancestor(repo: BaseRepo, old: bytes, new: bytes) -> bool:
    """Whether ``old`` is reachable from ``new``, a fast-forward.

    Args:
        repo (BaseRepo): the repository, holding both.
        old (bytes): the ref's current id.
        new (bytes): the id it would move to.
    """
    seen: set[bytes] = set()
    stack = [new]
    while stack:
        oid = stack.pop()
        if oid == old:
            return True
        if oid in seen:
            continue
        seen.add(oid)
        obj = repo.object_store[ObjectID(oid)]
        if isinstance(obj, Commit):
            stack.extend(obj.parents)
    return False


async def _receive(
    dispatch: DispatchFn,
    location: RepoLocation,
    transport: LocalTransport | HttpTransport,
    wants: list[str],
) -> BaseRepo:
    """Fetch what ``wants`` reaches that is missing, then reopen.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        location (RepoLocation): the receiving repository.
        transport (LocalTransport | HttpTransport): the remote.
        wants (list[str]): object ids asked for.
    """
    repo = await open_repo(dispatch, location)
    store = repo.object_store
    tips = {oid for oid in repo.refs.as_dict().values()}
    missing = [
        want
        for want in dict.fromkeys(wants)
        if not await asyncio.to_thread(
            store.__contains__, ObjectID(want.encode())
        )
    ]
    if not missing:
        return repo
    haves = [tip.decode() for tip in sorted(tips)]
    pack = await transport.fetch_pack(
        missing, haves, store.__contains__ if tips else (lambda _oid: False)
    )
    await store_pack(dispatch, location.commondir, pack)
    return await open_repo(dispatch, location)


def ignore_funny(wanted: list[Wanted]) -> tuple[list[Wanted], str]:
    """Drop the refs whose local name git refuses, as get_fetch_map does.

    The remote names its refs, so one it advertises as
    ``refs/tags/../../x`` would land outside ``.git``. git skips such a
    ref with an error and takes the rest (pinned against git 2.50.1).

    Args:
        wanted (list[Wanted]): the refs a fetch or clone takes.

    Returns:
        tuple[list[Wanted], str]: the refs kept, and the errors git
        prints for the others.
    """
    kept, notes = [], ""
    for want in wanted:
        if want.local is None or (
            want.local.startswith("refs/") and valid_ref_name(want.local)
        ):
            kept.append(want)
        else:
            notes += f"error: * Ignoring funny ref '{want.local}' locally\n"
    return kept, notes


def followed_tags(
    repo: BaseRepo, adv: Advertisement, taken: set[str]
) -> list[Wanted]:
    """The remote tags git follows: new here, pointing at what is here.

    A tag whose name git refuses is left out. git asks for it by name
    and dies on the answer; mirage takes the rest instead.

    Args:
        repo (BaseRepo): the receiving repository, after the fetch.
        adv (Advertisement): what the remote published.
        taken (set[str]): refs the fetch already takes.
    """
    local = repo.refs.as_dict()
    store = repo.object_store
    follow = []
    for name, oid in adv.refs.items():
        if (
            not name.startswith(TAGS)
            or name in taken
            or not valid_ref_name(name)
        ):
            continue
        if Ref(name.encode()) in local:
            continue
        if ObjectID(adv.peeled.get(name, oid).encode()) in store:
            follow.append(Wanted(name, oid, name))
    return follow


async def fetch_objects(
    dispatch: DispatchFn,
    location: RepoLocation,
    transport: LocalTransport | HttpTransport,
    adv: Advertisement,
    wanted: list[Wanted],
    follow: bool,
) -> tuple[BaseRepo, list[Wanted]]:
    """Bring in every wanted object, then the tags that follow them.

    Two rounds, as git does: the refs first, then any annotated tag
    whose target is now here but whose tag object is not.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        location (RepoLocation): the receiving repository.
        transport (LocalTransport | HttpTransport): the remote.
        adv (Advertisement): what the remote published.
        wanted (list[Wanted]): the refs to take.
        follow (bool): whether tags are auto-followed.
    """
    repo = await _receive(
        dispatch, location, transport, [want.oid for want in wanted]
    )
    if not follow:
        return repo, wanted
    tags = await asyncio.to_thread(
        followed_tags, repo, adv, {want.remote for want in wanted}
    )
    if tags:
        repo = await _receive(
            dispatch, location, transport, [tag.oid for tag in tags]
        )
    return repo, wanted + tags


def _classify(
    repo: BaseRepo, want: Wanted, old: bytes | None
) -> tuple[Row, str | None]:
    """The summary row for one ref update, and its reflog reason.

    A None reason means the ref is not written: it is unchanged, or the
    update was rejected.

    Args:
        repo (BaseRepo): the repository, after the fetch.
        want (Wanted): the update.
        old (bytes | None): what the local ref holds now.
    """
    local = want.local or ""
    remote = prettify(want.remote)
    shown = prettify(local)
    new = want.oid.encode()
    width = abbrev_for(repo)
    if old == new:
        return Row("=", "[up to date]", remote, shown), None
    if old is None:
        if local.startswith(TAGS):
            return Row(
                "*", "[new tag]", remote, shown, counted=True
            ), "storing tag"
        kind = "[new branch]" if want.remote.startswith(HEADS) else "[new ref]"
        return Row("*", kind, remote, shown, counted=True), "storing head"
    if local.startswith(TAGS) and not want.force:
        return Row(
            "!",
            "[rejected]",
            remote,
            shown,
            "would clobber existing tag",
            True,
        ), None
    ends = (old.decode()[:width], want.oid[:width])
    if _is_ancestor(repo, old, new):
        return Row(
            " ", "..".join(ends), remote, shown, counted=True
        ), "fast-forward"
    if want.force:
        return Row(
            "+", "...".join(ends), remote, shown, "forced update", True
        ), "forced-update"
    return Row(
        "!", "[rejected]", remote, shown, "non-fast-forward", True
    ), None


async def update_refs(
    dispatch: DispatchFn,
    repo: BaseRepo,
    location: RepoLocation,
    wanted: list[Wanted],
    reason: str,
    logged: bool,
) -> tuple[list[Row], bool]:
    """Move each local ref, returning the summary rows and any rejection.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        repo (BaseRepo): the repository, after the fetch.
        location (RepoLocation): where its refs live.
        wanted (list[Wanted]): the updates, in summary order.
        reason (str): the reflog prefix, ``fetch`` plus its arguments.
        logged (bool): ``core.logAllRefUpdates``, which a bare
            repository leaves off.
    """
    local = repo.refs.as_dict()
    rows = []
    rejected = False
    now = int(time.time())
    for want in wanted:
        if want.local is None:
            kind = (
                "tag"
                if want.remote.startswith(TAGS)
                else "remote-tracking branch"
                if want.remote.startswith(REMOTES)
                else "branch"
            )
            rows.append(Row("*", kind, prettify(want.remote), FETCH_HEAD))
            continue
        old = local.get(Ref(want.local.encode()))
        row, why = await asyncio.to_thread(_classify, repo, want, old)
        rows.append(row)
        rejected = rejected or row.code == "!"
        if why is None:
            continue
        await write_ref(
            dispatch, location.commondir, want.local, want.oid.encode()
        )
        if logged and not want.local.startswith(TAGS):
            await append(
                dispatch,
                location.commondir,
                f"logs/{want.local}",
                entry(
                    old or ZERO,
                    want.oid.encode(),
                    IDENTITY,
                    now,
                    f"{reason}: {why}",
                ),
            )
    return rows, rejected


def fetch_head(url: str, wanted: list[Wanted]) -> bytes:
    """FETCH_HEAD: every listed ref, the ones marked for merge first.

    Args:
        url (str): the remote URL, as displayed.
        wanted (list[Wanted]): the refs the fetch took.
    """
    lines = []
    for merge in (True, False):
        for want in wanted:
            if not want.listed or want.merge != merge:
                continue
            short = prettify(want.remote)
            what = (
                f"branch '{short}' of "
                if want.remote.startswith(HEADS)
                else f"tag '{short}' of "
                if want.remote.startswith(TAGS)
                else f"remote-tracking branch '{short}' of "
                if want.remote.startswith(REMOTES)
                else ""
                if want.remote == "HEAD"
                else f"'{want.remote}' of "
            )
            mark = "" if merge else "not-for-merge"
            lines.append(f"{want.oid}\t{mark}\t{what}{display_url(url)}\n")
    return "".join(lines).encode()


def _local_name(dst: str | None, remote: str) -> str | None:
    """A short refspec destination, spelled out as git does.

    ``main:copy`` lands in ``refs/heads/copy`` because ``main`` is a
    branch; a tag's lands under ``refs/tags/``.

    Args:
        dst (str | None): the destination as typed.
        remote (str): the full remote ref it takes.
    """
    if dst is None or dst.startswith("refs/") or dst == "HEAD":
        return dst
    return f"{TAGS if remote.startswith(TAGS) else HEADS}{dst}"


def _plan(
    adv: Advertisement,
    typed: list[Refspec],
    configured: list[Refspec],
    merge: str | None,
    all_tags: bool,
) -> list[Wanted]:
    """The refs a fetch takes, in the order git lists them.

    Refspecs on the line are taken for FETCH_HEAD and marked for merge,
    and the configured ones then update their remote-tracking refs
    opportunistically; without any on the line the configured ones are
    the whole fetch, and without those it is the remote's HEAD.

    Args:
        adv (Advertisement): what the remote published.
        typed (list[Refspec]): refspecs from the line.
        configured (list[Refspec]): ``remote.<name>.fetch``.
        merge (str | None): ``branch.<current>.merge`` for this remote.
        all_tags (bool): ``--tags``.
    """
    names = [name for name in adv.refs if name != "HEAD"]
    wanted: list[Wanted] = []
    specs = typed or configured
    for spec in specs:
        if "*" in spec.src:
            for name in names:
                dst = mapped(spec, name)
                if dst is not None:
                    wanted.append(
                        Wanted(
                            name,
                            adv.refs[name],
                            dst or None,
                            spec.force,
                            not typed and name == merge or bool(typed),
                        )
                    )
            continue
        found = next(
            (
                rule.format(spec.src)
                for rule in DWIM_RULES
                if rule.format(spec.src) in adv.refs
            ),
            None,
        )
        if found is None:
            raise GitError(f"couldn't find remote ref {spec.src}")
        wanted.append(
            Wanted(
                found,
                adv.refs[found],
                _local_name(spec.dst, found),
                spec.force,
                bool(typed) or found == merge,
            )
        )
    if not specs:
        if "HEAD" in adv.refs:
            wanted.append(Wanted("HEAD", adv.refs["HEAD"], None, merge=True))
    if typed:
        taken = {want.local for want in wanted}
        for spec in configured:
            for want in list(wanted):
                dst = mapped(spec, want.remote)
                if dst and dst not in taken:
                    taken.add(dst)
                    wanted.append(
                        replace(
                            want,
                            local=dst,
                            force=spec.force,
                            merge=False,
                            listed=False,
                        )
                    )
    if all_tags:
        spec = parse_refspec(ALL_TAGS)
        for name in names:
            if mapped(spec, name) and name not in {w.remote for w in wanted}:
                wanted.append(Wanted(name, adv.refs[name], name))
    return wanted


def _config(data: bytes | None) -> ConfigFile:
    return ConfigFile.from_file(BytesIO(data or b""))


async def configured_headers(
    inv: CLIInvocation[None], config: ConfigFile | None
) -> dict[str, str]:
    """``http.extraHeader`` from the user's config, then the repository's.

    Args:
        inv (CLIInvocation[None]): the invocation, for its env.
        config (ConfigFile | None): the repository's config, None
            before there is a repository.
    """
    values: list[bytes] = []
    if inv.env.get("HOME") or inv.env.get("GIT_CONFIG_GLOBAL") is not None:
        for _, user in await global_sources(inv, False):
            values += multivar(user, (b"http",), b"extraheader")
    if config is not None:
        values += multivar(config, (b"http",), b"extraheader")
    return extra_headers(values)


def leaf_args(argv: tuple[str, ...], verb: str) -> tuple[str, ...]:
    """The words after the verb, which git's reflog reason repeats.

    Args:
        argv (tuple[str, ...]): the line's tokens after ``git``.
        verb (str): the subcommand.
    """
    return argv[argv.index(verb) + 1 :] if verb in argv else ()


async def _prune(
    dispatch: DispatchFn,
    repo: BaseRepo,
    location: RepoLocation,
    adv: Advertisement,
    specs: list[Refspec],
) -> list[Row]:
    """Delete the remote-tracking refs whose remote ref is gone.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        repo (BaseRepo): the receiving repository.
        location (RepoLocation): where its refs live.
        adv (Advertisement): what the remote published.
        specs (list[Refspec]): the refspecs that were fetched.
    """
    rows = []
    symbolic = repo.refs.get_symrefs()
    for name in sorted(
        ref.decode() for ref in repo.refs.as_dict() if ref not in symbolic
    ):
        for spec in specs:
            if spec.dst is None or "*" not in spec.dst:
                continue
            source = mapped(Refspec(spec.dst, spec.src, False), name)
            if source and source not in adv.refs:
                await delete_ref(dispatch, location.commondir, name)
                rows.append(Row("-", "[deleted]", "(none)", prettify(name)))
                break
    return rows


async def fetch(
    inv: CLIInvocation[None],
) -> tuple[ByteSource | None, IOResult]:
    """Download objects and refs from another repository.

    Reaches a repository in the workspace through the dispatcher and an
    ``https://`` remote over smart HTTP. Updates the remote-tracking
    refs a remote's refspecs name, follows the tags that point into what
    arrived, writes FETCH_HEAD, and prints git's summary to stderr.

    Args:
        inv (CLIInvocation[None]): the parsed invocation.
    """
    fl = FlagView(inv.flags)
    try:
        check_switches(inv, inv.texts)
        doors = inv.doors or CLIDoors()
        _, location = await opened(fl, doors)
        dispatch = doors.dispatch
        if dispatch is None:
            raise NoWorkspaceError()
        config = _config(
            await read_optional(dispatch, f"{location.commondir}/config")
        )
        head = await read_head(dispatch, location.gitdir)
        texts = list(inv.texts)
        name = texts[0] if texts else None
        if name is None:
            branch = head.branch.encode() if head.branch else None
            remote = b"origin"
            if branch is not None:
                remote = next(
                    iter(multivar(config, (b"branch", branch), b"remote")),
                    b"origin",
                )
            name = remote.decode()
            if not multivar(config, (b"remote", remote), b"url"):
                if name == "origin" and not texts:
                    raise GitError(NO_REMOTE)
        urls = multivar(config, (b"remote", name.encode()), b"url")
        url = urls[-1].decode() if urls else name
        configured = (
            [
                parse_refspec(value.decode())
                for value in multivar(
                    config, (b"remote", name.encode()), b"fetch"
                )
            ]
            if urls
            else []
        )
        merge = None
        if head.branch is not None and urls:
            remotes = multivar(
                config, (b"branch", head.branch.encode()), b"remote"
            )
            if remotes and remotes[-1].decode() == name:
                merges = multivar(
                    config, (b"branch", head.branch.encode()), b"merge"
                )
                merge = merges[-1].decode() if merges else None
        bare = await is_bare(dispatch, location)
        start = location.gitdir if bare else location.worktree
        try:
            transport = await open_transport(
                url, start, doors, await configured_headers(inv, config)
            )
        except MissingRepositoryError as exc:
            raise GitError(
                f"'{url}' does not appear to be a git repository\n"
                f"{UNREACHABLE}"
            ) from exc
        adv = await transport.advertise()
        typed = [parse_refspec(text) for text in texts[1:]]
        wanted, notes = ignore_funny(
            _plan(adv, typed, configured, merge, fl.as_bool("tags"))
        )
        checked = None if bare else head.ref
        for want in wanted:
            if want.local is not None and want.local == checked:
                raise GitError(
                    f"refusing to fetch into branch '{checked}' "
                    f"checked out at '{location.worktree}'"
                )
        tag_opt = multivar(config, (b"remote", name.encode()), b"tagopt")
        follow = not fl.as_bool("no_tags") and tag_opt[-1:] != [b"--no-tags"]
        repo, taken = await fetch_objects(
            dispatch, location, transport, adv, wanted, follow
        )
        pruned = []
        if fl.as_bool("prune") and not typed:
            pruned = await _prune(dispatch, repo, location, adv, configured)
        reason = " ".join(("fetch", *leaf_args(inv.argv, "fetch")))
        rows, rejected = await update_refs(
            dispatch, repo, location, taken, reason, not bare
        )
        await write_file(
            dispatch,
            posixpath.join(location.gitdir, FETCH_HEAD),
            fetch_head(url, taken),
        )
        shown = pruned + [
            row for row in rows if row.code != "=" or fl.as_bool("verbose")
        ]
        err = notes + (
            ""
            if fl.as_bool("quiet")
            else summary_lines(url, shown, abbrev_for(repo))
        )
        return None, IOResult(
            exit_code=1 if rejected else 0, stderr=err.encode()
        )
    except GitError as exc:
        return fatal(exc)


def fetch_read_only(
    inv: CLIInvocation[None], location: RepoLocation | None
) -> GitError:
    """fetch's refusal by a read-only mount, at FETCH_HEAD, named the way
    git names it from the top of the work tree.

    Args:
        inv (CLIInvocation[None]): the line's invocation record.
        location (RepoLocation | None): the repository it opened.
    """
    if location is None or location.gitdir == posixpath.join(
        location.worktree, ".git"
    ):
        return FetchHeadReadOnlyError(f".git/{FETCH_HEAD}")
    return FetchHeadReadOnlyError(posixpath.join(location.gitdir, FETCH_HEAD))
