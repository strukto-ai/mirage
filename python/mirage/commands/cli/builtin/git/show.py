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
from io import BytesIO

from dulwich.objects import Commit
from dulwich.patch import write_tree_diff
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.errors import GitError
from mirage.commands.cli.builtin.git.format import entry
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.revparse import resolve_commit
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.util import (check_operands, fatal,
                                                  revision_arg)
from mirage.commands.cli.types import CLIInvocation, CLIVerbOpts
from mirage.commands.spec.types import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult

MERGE_PARENTS = 1

# A merge prints no ordinary diff. git renders one against every parent
# at once (`--cc`, the combined format with two prefix columns and
# `@@@` ranges), which comes out empty whenever the merge result matches
# a parent exactly, so the common merge shows only its header. Combined
# diffs are not implemented, so a merge that resolved a conflict shows
# its header and nothing else rather than a patch git would never print.


def _render(repo: BaseRepo, revision: str) -> bytes:
    """Resolve a revision and render its entry and patch, synchronously.

    Runs on a worker thread: resolving, walking the tree and reading
    blobs all fetch through the dispatcher, so this must not sit on the
    loop that answers those fetches.

    Args:
        repo (BaseRepo): repository to read.
        revision (str): the revision to show.
    """
    commit = resolve_commit(repo, revision)
    header = ("\n".join(entry(commit, abbrev_for(repo))) + "\n").encode()
    if len(commit.parents) > MERGE_PARENTS:
        return header
    parent_tree = None
    if commit.parents:
        parent = repo.object_store[commit.parents[0]]
        assert isinstance(parent, Commit)
        parent_tree = parent.tree
    patch = BytesIO()
    write_tree_diff(patch, repo.object_store, parent_tree, commit.tree)
    body = patch.getvalue()
    if not body:
        return header
    return header + b"\n" + body


async def show(inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    """Show one commit: its log entry, then its diff against its parent.

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
        repo, _location = await opened(fl, stat_path, mount_root, dispatch)
        rendered = await asyncio.to_thread(_render, repo, revision_arg(texts))
    except GitError as exc:
        return fatal(exc)
    return yield_bytes(rendered), IOResult()
