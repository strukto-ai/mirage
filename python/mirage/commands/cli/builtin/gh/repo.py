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

import base64
from typing import cast

from mirage.accessor.base import NOOPAccessor
from mirage.accessor.github import GitHubAccount
from mirage.commands.cli.builtin.gh.constants import GIST_ORIGIN, GITHUB_HOST
from mirage.commands.cli.builtin.gh.host import check_host, web_origin
from mirage.commands.cli.builtin.git import GIT
from mirage.commands.cli.builtin.git.clone import clone as git_clone
from mirage.commands.cli.builtin.git.util import split_marked
from mirage.commands.cli.cobra import COBRA_EXIT, cobra_refusal
from mirage.commands.cli.walk import find_node
from mirage.commands.config import Context
from mirage.commands.spec.parser import parse_command, parse_to_kwargs
from mirage.commands.spec.types import CommandSpec, FlagValue
from mirage.core.github.repo import RepoRef, login, parse_repo, repo_host
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec


def token_header(accessor: GitHubAccount) -> dict[str, str]:
    """The Authorization git sends GitHub for the install's token: Basic
    with the token as the password, what gh's credential helper hands git.

    Args:
        accessor (GitHubAccount): the install's account.
    """
    secret = f"x-access-token:{accessor.config.token.get_secret_value()}"
    return {
        "Authorization": f"Basic {base64.b64encode(secret.encode()).decode()}"
    }


async def clone_cmd(
    accessor: GitHubAccount,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """``gh repo clone``: mirage's ``git clone`` of the repository. As gh
    does, the words after the repository that are not gh's own flags go to
    git: the first one, when it has no leading dash, is the directory, put
    after the URL unless it is empty, and the rest go before the URL. The
    token rides only as the request's Authorization, never on the line, in
    the config or in the output, and only when git clones from the
    install's origin, as gh's credential helper is scoped to it; a fork's
    ``upstream`` remote is not added.

    Args:
        accessor (GitHubAccount): the install's account.
        paths (list[PathSpec]): the path operands.
        texts (list[str]): the repository, then the words for git.
        ctx (Context): the original argv and context.
    """
    names, gitflags = split_marked(tuple(texts), ctx.argv)
    if not names:
        return _usage_refusal(
            "cannot clone: repository argument required", "repo clone", ctx
        )
    spec = names[0]
    try:
        check_host(accessor, repo_host(spec))
        if "/" not in spec and ":" not in spec:
            ref = RepoRef(owner=await login(accessor), repo=spec)
        else:
            ref = parse_repo(spec)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=encode_text(f"{exc}\n"))
    origin = web_origin(accessor)
    url = f"{origin}/{ref.owner}/{ref.repo}.git"
    return await _clone(accessor, url, [*names[1:], *gitflags], ctx, origin)


async def gist_clone_cmd(
    accessor: GitHubAccount,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """``gh gist clone``: mirage's ``git clone`` of a gist, its id or URL
    first, then the words for git as ``gh repo clone`` reads them.

    Args:
        accessor (GitHubAccount): the install's account.
        paths (list[PathSpec]): the path operands.
        texts (list[str]): the gist, then the words for git.
        ctx (Context): the original argv and context.
    """
    names, gitflags = split_marked(tuple(texts), ctx.argv)
    if not names:
        return _usage_refusal(
            "cannot clone: gist argument required", "gist clone", ctx
        )
    gist = names[0].rstrip("/").rsplit("/", 1)[-1].removesuffix(".git")
    origin = web_origin(accessor)
    host = (
        GIST_ORIGIN if origin == f"https://{GITHUB_HOST}" else f"{origin}/gist"
    )
    url = f"{host}/{gist}.git"
    return await _clone(accessor, url, [*names[1:], *gitflags], ctx, host)


def _usage_refusal(
    message: str, leaf: str, ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """A flag error from a leaf the host runs itself.

    Args:
        message (str): the error.
        leaf (str): the leaf's path below gh.
        ctx (Context): the leaf's context, carrying its grammar.
    """
    text = cobra_refusal(message, f"gh {leaf}", cast(CommandSpec, ctx.spec))
    return None, IOResult(exit_code=COBRA_EXIT, stderr=encode_text(text))


async def _clone(
    accessor: GitHubAccount,
    url: str,
    rest: list[str],
    ctx: Context,
    origin: str,
) -> tuple[ByteSource | None, IOResult]:
    """Run mirage's ``git clone`` of ``url``, the words after it read as gh
    reads them.

    Args:
        accessor (GitHubAccount): the install's account.
        url (str): what to clone.
        rest (list[str]): the words for git.
        ctx (Context): the original argv and context.
        origin (str): where the install's token may be sent.
    """
    target = rest[:1] if rest and not rest[0].startswith("-") else []
    leaf, _ = find_node(GIT.spec, ["clone"]) or (GIT.spec, ())
    words = [*rest[len(target) :], url, *filter(None, target)]
    parsed = parse_command(
        leaf,
        words,
        ctx.cwd.virtual,
        "git clone",
        ctx.env,
        unknown_is_operand=True,
    )
    flags: dict[str, FlagValue] = dict(parse_to_kwargs(parsed))
    flags["C"] = ctx.cwd
    git = Context(
        argv=("clone", *words),
        cwd=ctx.cwd,
        flags=flags,
        stdin=ctx.stdin,
        env=ctx.env,
        vfs=ctx.vfs,
        session=ctx.session,
        processes=ctx.processes,
        spec=leaf,
    )
    operands = [word for word, _ in parsed.args]
    same_origin = bool(operands) and operands[0].startswith(f"{origin}/")
    return await git_clone(
        NOOPAccessor(),
        [],
        operands,
        git,
        token_header(accessor) if same_origin else None,
    )
