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
import time

from dulwich.objects import ObjectID

from mirage.commands.cli.builtin.git.checkout import (
    DETACHED_ADVICE,
    switch_to,
)
from mirage.commands.cli.builtin.git.errors import (
    CloneReadOnlyError,
    GitError,
    NoWorkspaceError,
    UsageError,
)
from mirage.commands.cli.builtin.git.fetch import (
    HEADS,
    TAGS,
    Wanted,
    configured_headers,
    fetch_objects,
    ignore_funny,
)
from mirage.commands.cli.builtin.git.init import lay_out
from mirage.commands.cli.builtin.git.io import (
    read_names,
    remove_tree,
    write_file,
)
from mirage.commands.cli.builtin.git.reflog import (
    IDENTITY,
    ZERO,
    append,
    entry,
)
from mirage.commands.cli.builtin.git.refs import (
    detach_head,
    set_head,
    valid_ref_name,
    write_ref,
)
from mirage.commands.cli.builtin.git.transport import (
    Advertisement,
    HttpTransport,
    LocalTransport,
    is_local,
    open_transport,
)
from mirage.commands.cli.builtin.git.tree import tree_of
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.commands.cli.builtin.git.util import (
    check_switches,
    config_section,
    fatal,
    links_of,
    mounts_of,
    start_point,
    verb_usage,
)
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec
from mirage.utils.path import join_spec, typed_spec

DEFAULT_BRANCH = "master"


def default_directory(url: str) -> str:
    """The directory git names a clone after, as ``guess_dir_name`` does.

    Args:
        url (str): the repository as typed.
    """
    path = url.rstrip("/")
    if path.endswith("/.git"):
        path = path[: -len("/.git")].rstrip("/")
    if path.endswith(".git"):
        path = path[: -len(".git")]
    return re.split(r"[/:]", path)[-1]


def _config(url: str, remote: str, branch: str | None) -> str:
    """A clone's config, in the order git writes it.

    Args:
        url (str): the remote's URL.
        remote (str): the remote's name.
        branch (str | None): the branch checked out, None when detached.
    """
    text = (
        "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n"
        "\tbare = false\n\tlogallrefupdates = true\n"
        + config_section(
            "remote",
            remote,
            [
                ("url", url),
                ("fetch", f"+refs/heads/*:refs/remotes/{remote}/*"),
            ],
        )
    )
    if branch is not None:
        text += config_section(
            "branch",
            branch,
            [("remote", remote), ("merge", f"{HEADS}{branch}")],
        )
    return text


def remote_head(
    adv: Advertisement, chosen: str | None
) -> tuple[str | None, str | None]:
    """The branch a clone checks out and the commit it starts at.

    Args:
        adv (Advertisement): what the remote published.
        chosen (str | None): ``--branch``, a branch or a tag name.
    """
    if chosen is not None:
        for ref in (f"{HEADS}{chosen}", f"{TAGS}{chosen}"):
            if ref in adv.refs:
                oid = adv.peeled.get(ref, adv.refs[ref])
                return (chosen if ref.startswith(HEADS) else None), oid
        return chosen, None
    if adv.head is not None and adv.head in adv.refs:
        return adv.head[len(HEADS) :], adv.refs[adv.head]
    if "HEAD" in adv.refs:
        return None, adv.refs["HEAD"]
    return None, None


async def clone(
    inv: CLIInvocation[None],
) -> tuple[ByteSource | None, IOResult]:
    """Clone a repository into a new directory.

    A path or ``file://`` URL is a repository inside the workspace, an
    ``https://`` one is fetched over smart HTTP. Every branch lands as a
    remote-tracking ref and every tag as a tag, the remote's HEAD branch
    is checked out. A failed clone removes what it wrote, and keeps a
    directory that was already there, empty, as git does.

    Args:
        inv (CLIInvocation[None]): the parsed invocation.
    """
    fl = FlagView(inv.flags)
    doors = inv.doors or CLIDoors()
    dispatch, stat_path = doors.dispatch, doors.stat_path
    try:
        check_switches(inv, inv.texts)
        if not inv.texts:
            raise UsageError(
                "",
                "fatal: You must specify a repository to clone.\n\n"
                + verb_usage(inv),
            )
    except GitError as exc:
        return fatal(exc)
    url = inv.texts[0]
    name = inv.texts[1] if len(inv.texts) > 1 else default_directory(url)
    quiet = fl.as_bool("quiet")
    try:
        if dispatch is None or stat_path is None:
            raise NoWorkspaceError()
        start = start_point(fl)
        target = join_spec(start, name)
        info = await stat_path(target)
        if info is not None and (
            info.type is not FileType.DIRECTORY
            or await read_names(dispatch, target)
        ):
            raise GitError(
                f"destination path '{name}' already exists and "
                "is not an empty directory."
            )
        transport = await open_transport(
            url, start, doors, await configured_headers(inv, None)
        )
    except GitError as exc:
        return fatal(exc)
    local = is_local(url)
    # git records a local path the way absolute_pathdup spells it: the
    # directory it ran in and the path as typed, not normalized.
    stored = (
        url
        if not local or url.startswith("/")
        else f"{start.virtual.rstrip('/')}/{url}"
    )
    notes = "" if quiet else f"Cloning into '{name}'...\n"
    try:
        notes += await _populate(
            inv, doors, transport, target, stored, local and not quiet
        )
    except GitError as exc:
        if info is None:
            await remove_tree(
                dispatch, target, links_of(doors), mounts_of(doors)
            )
        else:
            for entry in await read_names(dispatch, target):
                child = posixpath.basename(entry.rstrip("/"))
                await remove_tree(
                    dispatch,
                    join_spec(target, child),
                    links_of(doors),
                    mounts_of(doors),
                )
        refusal = str(exc) if exc.prefix is None else f"{exc.prefix}: {exc}"
        return None, IOResult(
            exit_code=exc.code, stderr=f"{notes}{refusal}\n".encode()
        )
    return None, IOResult(stderr=notes.encode())


async def _populate(
    inv: CLIInvocation[None],
    doors: CLIDoors,
    transport: LocalTransport | HttpTransport,
    target: PathSpec,
    url: str,
    local: bool,
) -> str:
    """Lay the clone out, fetch into it and check it out.

    Args:
        inv (CLIInvocation[None]): the parsed invocation.
        doors (CLIDoors): the invocation's doors.
        transport (LocalTransport | HttpTransport): the remote.
        target (PathSpec): the clone's working tree.
        url (str): the remote URL as the config records it.
        local (bool): whether git prints ``done.`` after copying.

    Returns:
        str: what the clone prints to stderr after ``Cloning into``.
    """
    fl = FlagView(inv.flags)
    dispatch, stat_path = doors.dispatch, doors.stat_path
    assert dispatch is not None and stat_path is not None
    mounts = doors.ns.mounts if doors.ns is not None else None
    gitdir = join_spec(target, ".git")
    remote = fl.as_str("origin") or "origin"
    if not valid_ref_name(f"refs/remotes/{remote}/test"):
        raise GitError(f"'{remote}' is not a valid remote name")
    await lay_out(dispatch, gitdir, DEFAULT_BRANCH, "")
    advertised = await transport.advertise()
    location = RepoLocation(
        gitdir,
        gitdir,
        target,
        typed_spec(mounts.root_of(target.virtual) if mounts else "/", "/"),
    )
    wanted, notes = ignore_funny(
        [
            Wanted(
                ref,
                oid,
                f"refs/remotes/{remote}/{ref[len(HEADS) :]}"
                if ref.startswith(HEADS)
                else ref,
            )
            for ref, oid in advertised.refs.items()
            if ref.startswith(HEADS) or ref.startswith(TAGS)
        ]
    )
    # Only what survived is a candidate for the branch to check out: a
    # HEAD naming a refused branch detaches, as git's does.
    kept = {want.remote for want in wanted}
    adv = Advertisement(
        {
            ref: oid
            for ref, oid in advertised.refs.items()
            if ref in kept or ref == "HEAD"
        },
        {ref: oid for ref, oid in advertised.peeled.items() if ref in kept},
        advertised.head if advertised.head in kept else None,
    )
    branch, commit = remote_head(adv, fl.as_str("branch"))
    if fl.as_str("branch") is not None and commit is None:
        raise GitError(
            f"Remote branch {branch} not found in upstream {remote}"
        )
    if not advertised.refs:
        notes += "warning: You appear to have cloned an empty repository.\n"
        head = advertised.head
        branch = (
            head
            if head is not None
            and head.startswith(HEADS)
            and valid_ref_name(head)
            else f"{HEADS}{DEFAULT_BRANCH}"
        )[len(HEADS) :]
    repo, _ = await fetch_objects(
        dispatch, location, transport, adv, wanted, False
    )
    for want in wanted:
        assert want.local is not None
        await write_ref(dispatch, gitdir, want.local, want.oid.encode())
    reason = f"clone: from {url}"
    now = int(time.time())
    if adv.head is not None and adv.head in adv.refs:
        tracking = f"refs/remotes/{remote}/HEAD"
        await write_file(
            dispatch,
            join_spec(gitdir, tracking),
            f"ref: refs/remotes/{remote}/{adv.head[len(HEADS) :]}\n".encode(),
        )
        await append(
            dispatch,
            gitdir,
            f"logs/{tracking}",
            entry(ZERO, adv.refs[adv.head].encode(), IDENTITY, now, reason),
        )
    await write_file(
        dispatch,
        join_spec(gitdir, "config"),
        _config(url, remote, branch).encode(),
    )
    if local:
        notes += "done.\n"
    if commit is None:
        await set_head(dispatch, gitdir, f"{HEADS}{branch}")
        return notes
    line = entry(ZERO, commit.encode(), IDENTITY, now, reason)
    if branch is not None:
        await write_ref(dispatch, gitdir, f"{HEADS}{branch}", commit.encode())
        await set_head(dispatch, gitdir, f"{HEADS}{branch}")
        await append(dispatch, gitdir, f"logs/{HEADS}{branch}", line)
    else:
        await detach_head(dispatch, gitdir, commit.encode())
        notes += f"Note: switching to '{commit}'.\n\n{DETACHED_ADVICE}\n"
    await append(dispatch, gitdir, "logs/HEAD", line)
    if not fl.as_bool("no_checkout"):
        tree = await asyncio.to_thread(
            tree_of, repo, ObjectID(commit.encode())
        )
        await switch_to(
            dispatch,
            stat_path,
            repo,
            location,
            {},
            tree,
            links_of(doors),
            mounts,
        )
    return notes


def clone_read_only(
    inv: CLIInvocation[None], location: RepoLocation | None
) -> GitError:
    """clone's refusal by a read-only mount, at the work tree it could
    not make.

    Args:
        inv (CLIInvocation[None]): the line's invocation record.
        location (RepoLocation | None): the repository it opened.
    """
    texts = inv.texts
    return CloneReadOnlyError(
        texts[1]
        if len(texts) > 1
        else default_directory(texts[0] if texts else "")
    )
