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
from collections.abc import Mapping

from dulwich.objects import ObjectID

from mirage.accessor.base import Accessor
from mirage.commands.cli.builtin.git.checkout import (
    DETACHED_ADVICE,
    switch_to,
)
from mirage.commands.cli.builtin.git.constants import DEFAULT_BRANCH
from mirage.commands.cli.builtin.git.errors import (
    CloneReadOnlyError,
    GitError,
    UsageError,
)
from mirage.commands.cli.builtin.git.fetch import (
    Wanted,
    configured_headers,
    fetch_objects,
    ignore_funny,
)
from mirage.commands.cli.builtin.git.init import lay_out
from mirage.commands.cli.builtin.git.io import (
    read_names,
    remove_tree,
    stat_of,
    write_file,
)
from mirage.commands.cli.builtin.git.reflog import (
    IDENTITY,
    ZERO,
    append,
    entry,
)
from mirage.commands.cli.builtin.git.refs import (
    BRANCH_PREFIX,
    TAG_PREFIX,
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
from mirage.commands.cli.builtin.git.tree import commit_entries
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.commands.cli.builtin.git.util import (
    check_switches,
    config_section,
    require_vfs,
    start_point,
    verb_usage,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec


def default_directory(url: str) -> str:
    """The directory git names a clone after when none is given.

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
            [("remote", remote), ("merge", f"{BRANCH_PREFIX}{branch}")],
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
        for ref in (f"{BRANCH_PREFIX}{chosen}", f"{TAG_PREFIX}{chosen}"):
            if ref in adv.refs:
                oid = adv.peeled.get(ref, adv.refs[ref])
                return (chosen if ref.startswith(BRANCH_PREFIX) else None), oid
        return chosen, None
    if adv.head is not None and adv.head in adv.refs:
        return adv.head[len(BRANCH_PREFIX) :], adv.refs[adv.head]
    if "HEAD" in adv.refs:
        return None, adv.refs["HEAD"]
    return None, None


async def clone(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    credentials: Mapping[str, str] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Clone a repository into a new directory.

    A path or ``file://`` URL is a repository inside the workspace, an
    ``https://`` one is fetched over smart HTTP. Every branch lands as a
    remote-tracking ref and every tag as a tag, the remote's HEAD branch
    is checked out. A failed clone removes what it wrote, and keeps a
    directory that was already there, empty, as git does.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the repository and the optional directory.
        ctx (Context): the line's context.
        credentials (Mapping[str, str] | None): the Authorization
            ``gh repo clone`` sends, scoped to the URL's origin as userinfo
            is and never written to the clone's config.
    """
    fl = FlagView(ctx.flags)
    vfs = require_vfs(ctx)
    check_switches(ctx, texts)
    if not texts:
        raise UsageError(
            "",
            "fatal: You must specify a repository to clone.\n\n"
            + verb_usage(ctx),
        )
    if len(texts) > 2:
        raise UsageError(
            "", "fatal: Too many arguments.\n\n" + verb_usage(ctx)
        )
    url = texts[0]
    name = texts[1] if len(texts) > 1 else default_directory(url)
    quiet = fl.as_bool("quiet")
    start = start_point(fl)
    target = start.join(name)
    info = await stat_of(vfs, target)
    if info is not None and (
        info.type is not FileType.DIRECTORY or await read_names(vfs, target)
    ):
        raise GitError(
            f"destination path '{name}' already exists and "
            "is not an empty directory."
        )
    transport = await open_transport(
        ctx, url, start, await configured_headers(ctx, None), credentials
    )
    local = is_local(url)
    # git records a local path as the directory it ran in joined to the
    # path as typed, not normalized.
    stored = (
        url
        if not local or url.startswith("/")
        else f"{start.virtual.rstrip('/')}/{url}"
    )
    notes = "" if quiet else f"Cloning into '{name}'...\n"
    try:
        notes += await _populate(
            ctx, transport, target, stored, local and not quiet
        )
    except GitError as exc:
        if info is None:
            await remove_tree(vfs, target)
        else:
            for entry in await read_names(vfs, target):
                child = posixpath.basename(entry.rstrip("/"))
                await remove_tree(
                    vfs,
                    target.join(child),
                )
        refusal = str(exc) if exc.prefix is None else f"{exc.prefix}: {exc}"
        return None, IOResult(
            exit_code=exc.exit_code, stderr=f"{notes}{refusal}\n".encode()
        )
    return None, IOResult(stderr=notes.encode())


async def _populate(
    ctx: Context,
    transport: LocalTransport | HttpTransport,
    target: PathSpec,
    url: str,
    local: bool,
) -> str:
    """Lay the clone out, fetch into it and check it out.

    Args:
        ctx (Context): the line's context.
        transport (LocalTransport | HttpTransport): the remote.
        target (PathSpec): the clone's working tree.
        url (str): the remote URL as the config records it.
        local (bool): whether git prints ``done.`` after copying.

    Returns:
        str: what the clone prints to stderr after ``Cloning into``.
    """
    fl = FlagView(ctx.flags)
    vfs = ctx.vfs
    assert vfs is not None
    gitdir = target.join(".git")
    remote = fl.as_str("origin", "origin")
    if not valid_ref_name(f"refs/remotes/{remote}/test"):
        raise GitError(f"'{remote}' is not a valid remote name")
    await lay_out(vfs, gitdir, DEFAULT_BRANCH, "")
    advertised = await transport.advertise()
    location = RepoLocation(
        gitdir,
        gitdir,
        target,
        PathSpec.from_str_path(vfs.mount_of(target) or "/", cwd="/"),
    )
    wanted, notes = ignore_funny(
        [
            Wanted(
                ref,
                oid,
                f"refs/remotes/{remote}/{ref[len(BRANCH_PREFIX) :]}"
                if ref.startswith(BRANCH_PREFIX)
                else ref,
            )
            for ref, oid in advertised.refs.items()
            if ref.startswith(BRANCH_PREFIX) or ref.startswith(TAG_PREFIX)
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
    # No HEAD to start from, in an empty remote or one whose HEAD names a
    # branch it lacks: the clone is born on the branch that HEAD names,
    # as git's unborn advertisement leaves it, or on the default one.
    if branch is None and commit is None:
        head = advertised.head
        branch = (
            head
            if head is not None
            and head.startswith(BRANCH_PREFIX)
            and valid_ref_name(head)
            else f"{BRANCH_PREFIX}{DEFAULT_BRANCH}"
        )[len(BRANCH_PREFIX) :]
    repo, _ = await fetch_objects(vfs, location, transport, adv, wanted, False)
    for want in wanted:
        assert want.local is not None
        await write_ref(vfs, gitdir, want.local, want.oid.encode())
    reason = f"clone: from {url}"
    now = int(time.time())
    if adv.head is not None and adv.head in adv.refs:
        tracking = f"refs/remotes/{remote}/HEAD"
        await write_file(
            vfs,
            gitdir.join(tracking),
            f"ref: refs/remotes/{remote}/{adv.head[len(BRANCH_PREFIX) :]}\n".encode(),
        )
        await append(
            vfs,
            gitdir,
            f"logs/{tracking}",
            entry(ZERO, adv.refs[adv.head].encode(), IDENTITY, now, reason),
        )
    await write_file(
        vfs,
        gitdir.join("config"),
        _config(url, remote, branch).encode(),
    )
    if local:
        notes += "done.\n"
    if commit is None:
        if advertised.refs and not fl.as_bool("no_checkout"):
            notes += (
                "warning: remote HEAD refers to nonexistent ref, "
                "unable to checkout\n"
            )
        await set_head(vfs, gitdir, f"{BRANCH_PREFIX}{branch}")
        return notes
    line = entry(ZERO, commit.encode(), IDENTITY, now, reason)
    if branch is not None:
        await write_ref(
            vfs, gitdir, f"{BRANCH_PREFIX}{branch}", commit.encode()
        )
        await set_head(vfs, gitdir, f"{BRANCH_PREFIX}{branch}")
        await append(vfs, gitdir, f"logs/{BRANCH_PREFIX}{branch}", line)
    else:
        await detach_head(vfs, gitdir, commit.encode())
        notes += f"Note: switching to '{commit}'.\n\n{DETACHED_ADVICE}\n"
    await append(vfs, gitdir, "logs/HEAD", line)
    if not fl.as_bool("no_checkout"):
        tree = await asyncio.to_thread(
            commit_entries, repo, ObjectID(commit.encode())
        )
        await switch_to(
            vfs,
            repo,
            location,
            {},
            tree,
        )
    return notes


def clone_read_only(
    texts: list[str], ctx: Context, location: RepoLocation | None
) -> GitError:
    """clone's refusal by a read-only mount, at the work tree it could
    not make.

    Args:
        texts (list[str]): the line's operands.
        ctx (Context): the line's context.
        location (RepoLocation | None): the repository it opened.
    """
    return CloneReadOnlyError(
        texts[1]
        if len(texts) > 1
        else default_directory(texts[0] if texts else "")
    )
