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

from dulwich.objects import Commit
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.errors import GitError
from mirage.commands.cli.builtin.git.format import (FULL_SHA, Decorations,
                                                    needs_decorations, oneline,
                                                    preset_block,
                                                    render_template)
from mirage.commands.cli.builtin.git.history import (LogFlags, decorations,
                                                     parse_flags, ref_commits,
                                                     select)
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.revparse import resolve_commit
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.util import (check_operands, fatal,
                                                  revision_arg)
from mirage.commands.cli.types import CLIInvocation, CLIVerbOpts
from mirage.commands.spec.types import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import encode_text


def _collect(repo: BaseRepo, revision: str, flags: LogFlags,
             want_decor: bool) -> tuple[list[Commit], Decorations | None]:
    """Resolve the starting points and walk them, synchronously.

    Runs on a worker thread. dulwich's walker is synchronous and now
    fetches objects as it goes, so it has to sit off the event loop that
    serves those fetches; enumerating refs and peeling tags fetch the
    same way, which is why ``--all`` and the decoration table are
    resolved here too.

    Args:
        repo (BaseRepo): repository to walk.
        revision (str): the revision to start from.
        flags (LogFlags): the parsed invocation.
        want_decor (bool): whether the format renders %d/%D.
    """
    starts = [resolve_commit(repo, revision)]
    if flags.all_refs:
        starts.extend(ref_commits(repo))
    commits = select(repo, starts, flags)
    return commits, decorations(repo) if want_decor else None


def _rendered(commits: list[Commit], flags: LogFlags, width: int,
              decor: Decorations | None) -> bytes:
    """The bytes a log invocation prints for its selected commits.

    ``format:`` separates entries with a newline and ends without one,
    and an entry that renders empty still claims its separator, so
    ``--pretty=format:`` prints one newline per commit past the first.
    ``tformat:`` (and any bare ``%`` string) terminates every entry,
    empty ones included - except that an empty template prints nothing
    at all, which is how ``--format=`` stays silent. Bytes go out
    through ``encode_text`` because ``%xHH`` names a raw byte. Pinned
    against git 2.37 and 2.54.

    Args:
        commits (list[Commit]): the selected commits, in print order.
        flags (LogFlags): the parsed invocation.
        width (int): abbreviated id width for this repository.
        decor (Decorations | None): ref labels when the format asked.
    """
    fmt = flags.pretty
    if fmt.kind == "oneline":
        length = width if flags.abbrev_commit else FULL_SHA
        lines = [oneline(commit, length) for commit in commits]
        return ("\n".join(lines) + "\n").encode() if lines else b""
    if fmt.kind in ("format", "tformat"):
        rendered = [
            render_template(fmt.template or "", commit, width, decor)
            for commit in commits
        ]
        if fmt.kind == "tformat":
            if not fmt.template:
                return b""
            return encode_text("".join(f"{text}\n" for text in rendered))
        return encode_text("\n".join(rendered))
    lines = []
    for index, commit in enumerate(commits):
        if index:
            lines.append("")
        lines.extend(preset_block(commit, fmt.kind, width))
    return ("\n".join(lines) + "\n").encode() if lines else b""


async def log(inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    """Show commit logs.

    Args:
        inv (CLIInvocation[None]): the line's invocation record.
            git declares no config_model, and the workspace doors
            it reads (dispatch, stat_path, mount_root) ride
            ``inv.ops``.
    """
    ops = inv.ops or CLIVerbOpts()
    dispatch = ops.dispatch
    stat_path = ops.stat_path
    mount_root = ops.mount_root
    texts = inv.texts
    flags = inv.flags
    fl = FlagView(flags)
    try:
        check_operands(texts)
        parsed = parse_flags(fl)
        repo, _location = await opened(fl, stat_path, mount_root, dispatch)
        commits, decor = await asyncio.to_thread(
            _collect, repo, revision_arg(texts), parsed,
            needs_decorations(parsed.pretty))
    except GitError as exc:
        return fatal(exc)
    out = _rendered(commits, parsed, abbrev_for(repo), decor)
    if not out:
        return None, IOResult()
    return yield_bytes(out), IOResult()
