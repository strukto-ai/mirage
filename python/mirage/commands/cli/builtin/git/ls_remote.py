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

from io import BytesIO
from typing import BinaryIO, cast

from dulwich.config import ConfigFile

from mirage.accessor.base import Accessor
from mirage.commands.cli.builtin.git.dates import date_clock
from mirage.commands.cli.builtin.git.discover import is_bare
from mirage.commands.cli.builtin.git.errors import (
    GitError,
    MissingRepositoryError,
    UsageError,
)
from mirage.commands.cli.builtin.git.fetch import (
    UNREACHABLE,
    configured_headers,
)
from mirage.commands.cli.builtin.git.inspect import rewrite_url, url_rules
from mirage.commands.cli.builtin.git.ref_fields import needs_object
from mirage.commands.cli.builtin.git.ref_format import ValueTable, sort_refs
from mirage.commands.cli.builtin.git.ref_list import (
    ref_listing,
    ref_object,
    sort_keys,
)
from mirage.commands.cli.builtin.git.refs import read_head
from mirage.commands.cli.builtin.git.repo import overrides_text, read_config
from mirage.commands.cli.builtin.git.session import inside, opened
from mirage.commands.cli.builtin.git.transport import (
    PEELED,
    Advertisement,
    display_url,
    open_transport,
)
from mirage.commands.cli.builtin.git.types import (
    RefContext,
    RefItem,
    RefKind,
    RefSortKey,
    RepoLocation,
)
from mirage.commands.cli.builtin.git.util import (
    command_line_config,
    multivar,
    option_operand,
    require_vfs,
    start_point,
    verb_usage,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.fnmatch import fnmatch
from mirage.workspace.files import Files

NOTHING_CONFIGURED = "No remote configured to list refs from."
HEADS_NAMESPACE = "refs/heads/"
TAGS_NAMESPACE = "refs/tags/"
REFS_NAMESPACE = "refs/"
HEAD_NAME = "HEAD"
HELP_SWITCH = "-h"
NOTHING_LISTED = 2

_Row = tuple[str, str]


async def _config_of(
    ctx: Context, vfs: Files, location: RepoLocation | None
) -> ConfigFile:
    """The repository's configuration; outside one, the command line's.

    Args:
        ctx (Context): the line's context.
        vfs (Files): the session's files.
        location (RepoLocation | None): the discovered repository.
    """
    if location is None:
        typed = overrides_text(tuple(command_line_config(ctx)))
        return ConfigFile.from_file(cast(BinaryIO, BytesIO(typed)))
    return await read_config(vfs, location)


def _default_remote(cfg: ConfigFile, branch: str | None) -> str:
    """The remote a line naming none lists: the branch's, else the one
    remote defined, else ``origin``.

    Args:
        cfg (ConfigFile): repository configuration.
        branch (str | None): the checked-out branch.
    """
    if branch is not None:
        named = multivar(cfg, (b"branch", branch.encode()), b"remote")
        if named:
            return named[-1].decode()
    names = [
        section[1].decode()
        for section in cfg.sections()
        if len(section) == 2 and section[0] == b"remote"
    ]
    return names[0] if len(names) == 1 else "origin"


def _rows_of(adv: Advertisement) -> list[_Row]:
    """Every advertised name and id, a tag's peeled row after it.

    Args:
        adv (Advertisement): what the remote published.
    """
    rows: list[_Row] = []
    for name, oid in adv.refs.items():
        rows.append((name, oid))
        peeled = adv.peeled.get(name)
        if peeled is not None:
            rows.append((f"{name}{PEELED}", peeled))
    return rows


def _listed(name: str, fl: FlagView, patterns: list[str]) -> bool:
    """Whether the line's options keep one advertised name.

    A pattern matches the name's tail at a slash, its ``*`` crossing
    slashes.

    Args:
        name (str): the advertised name.
        fl (FlagView): parsed flags.
        patterns (list[str]): the patterns typed after the remote.
    """
    if fl.as_bool("refs") and (
        not name.startswith(REFS_NAMESPACE) or name.endswith(PEELED)
    ):
        return False
    heads = fl.as_bool("heads") or fl.as_bool("branches")
    tags = fl.as_bool("tags")
    if (heads or tags) and not (
        (heads and name.startswith(HEADS_NAMESPACE))
        or (tags and name.startswith(TAGS_NAMESPACE))
    ):
        return False
    return not patterns or any(
        fnmatch(f"/{name}", f"*/{pattern}") for pattern in patterns
    )


async def _in_order(
    ctx: Context,
    fl: FlagView,
    rows: list[_Row],
    keys: tuple[RefSortKey, ...],
    cfg: ConfigFile,
    in_repo: bool,
) -> list[_Row]:
    """The rows in the order the ``--sort`` keys give.

    A key reading an object needs that object here, where a remote's
    ids are usually not.

    Args:
        ctx (Context): the line's context.
        fl (FlagView): parsed flags.
        rows (list[_Row]): the names and ids.
        keys (tuple[RefSortKey, ...]): the keys, primary first.
        cfg (ConfigFile): repository configuration.
        in_repo (bool): whether the line runs inside a repository.

    Raises:
        GitError: a key needs an object that is not here.
    """
    fields = [key.field for key in keys]
    reading = [field for field in fields if needs_object(field)]
    if reading and not in_repo:
        raise GitError(
            "not a git repository, but the field "
            f"'{reading[0].name}' requires access to object data"
        )
    ref_ctx = RefContext()
    repo = None
    if in_repo:
        repo, _ = await opened(ctx, fl)
        _, ref_ctx, _ = await ref_listing(
            repo, cfg, fields, lambda name: False, None, date_clock(ctx.env)
        )
    items: list[RefItem] = []
    for name, oid in rows:
        obj = None
        if reading and repo is not None:
            try:
                obj = ref_object(repo, oid)
            except KeyError as exc:
                raise GitError(f"missing object {oid} for {name}") from exc
        items.append(RefItem(name, oid, RefKind.OTHER, obj=obj))
    table = ValueTable(fields, ref_ctx)
    done = sort_refs(items, keys, table, ref_ctx, False)
    return [(item.name, item.oid) for item in done]


async def ls_remote(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """List the refs another repository publishes.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the remote, then the patterns.
        ctx (Context): the line's context.
    """
    fl = FlagView(ctx.flags)
    vfs = require_vfs(ctx)
    if tuple(ctx.argv[-2:]) == ("ls-remote", HELP_SWITCH):
        raise UsageError(verb_usage(ctx), "")
    if option_operand(ctx, texts) is not None:
        raise UsageError("", verb_usage(ctx))
    keys = sort_keys(fl, ())
    location = await inside(ctx, fl)
    cfg = await _config_of(ctx, vfs, location)
    named = texts[0] if texts else None
    remote = named
    if remote is None:
        branch = None
        if location is not None:
            branch = (await read_head(vfs, location.gitdir)).branch
        remote = _default_remote(cfg, branch)
    urls = multivar(cfg, (b"remote", remote.encode()), b"url")
    if named is None and not urls:
        raise GitError(NOTHING_CONFIGURED)
    url = rewrite_url(urls[0].decode() if urls else remote, url_rules(cfg)[0])
    if fl.as_bool("get_url"):
        return f"{url}\n".encode(), IOResult()
    start = start_point(fl)
    if location is not None:
        bare = await is_bare(vfs, location)
        start = location.gitdir if bare else location.worktree
    try:
        transport = await open_transport(
            ctx, url, start, await configured_headers(ctx, cfg)
        )
    except MissingRepositoryError as exc:
        raise GitError(
            f"'{url}' does not appear to be a git repository\n{UNREACHABLE}"
        ) from exc
    adv = await transport.advertise()
    patterns = list(texts[1:])
    rows = [row for row in _rows_of(adv) if _listed(row[0], fl, patterns)]
    if keys is not None:
        rows = await _in_order(ctx, fl, rows, keys, cfg, location is not None)
    targets = dict(adv.symrefs)
    if adv.head is not None:
        targets.setdefault(HEAD_NAME, adv.head)
    show_symrefs = fl.as_bool("symref")
    lines: list[str] = []
    for name, oid in rows:
        if show_symrefs and name in targets:
            lines.append(f"ref: {targets[name]}\t{name}\n")
        lines.append(f"{oid}\t{name}\n")
    told = named is None and not fl.as_bool("quiet")
    stderr = f"From {display_url(url)}\n".encode() if told else None
    code = NOTHING_LISTED if fl.as_bool("exit_code") and not rows else 0
    out = "".join(lines).encode()
    return out or None, IOResult(exit_code=code, stderr=stderr)
