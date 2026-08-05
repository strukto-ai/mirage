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
from typing import Any, Callable

from dulwich.objects import Commit
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.errors import GitError
from mirage.commands.cli.builtin.git.format import entry, oneline
from mirage.commands.cli.builtin.git.history import (LogFlags, parse_flags,
                                                     select)
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.revparse import resolve_commit
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.util import (check_operands, fatal,
                                                  revision_arg)
from mirage.commands.spec.types import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import MountRoot, StatPath
from mirage.types import PathSpec


def _collect(repo: BaseRepo, revision: str, flags: LogFlags) -> list[Commit]:
    """Resolve the starting revision and walk it, synchronously.

    Runs on a worker thread. dulwich's walker is synchronous and now
    fetches objects as it goes, so it has to sit off the event loop that
    serves those fetches.

    Args:
        repo (BaseRepo): repository to walk.
        revision (str): the revision to start from.
        flags (LogFlags): the parsed invocation.
    """
    return select(repo, resolve_commit(repo, revision), flags)


async def log(
    config: None,
    paths: list[PathSpec],
    *texts: str,
    stat_path: StatPath | None = None,
    mount_root: MountRoot | None = None,
    dispatch: Callable[..., Any] | None = None,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    """Show commit logs.

    Args:
        config (None): git declares no config_model.
        paths (list[PathSpec]): path operands.
        stat_path (StatPath | None): dispatcher-backed stat, both
            channels.
        mount_root (MountRoot | None): the mount prefix serving a path.
        dispatch (Callable | None): workspace op dispatcher.
    """
    fl = FlagView(flags)
    try:
        check_operands(texts)
        parsed = parse_flags(fl)
        repo, _location = await opened(fl, stat_path, mount_root, dispatch)
        commits = await asyncio.to_thread(_collect, repo, revision_arg(texts),
                                          parsed)
    except GitError as exc:
        return fatal(exc)
    width = abbrev_for(repo)
    if parsed.oneline:
        lines = [oneline(commit, width) for commit in commits]
    else:
        blocks = [entry(commit, width) for commit in commits]
        lines = []
        for index, block in enumerate(blocks):
            if index:
                lines.append("")
            lines.extend(block)
    if not lines:
        return None, IOResult()
    return yield_bytes(("\n".join(lines) + "\n").encode()), IOResult()
