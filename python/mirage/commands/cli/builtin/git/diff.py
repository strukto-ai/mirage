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

from dulwich.patch import write_tree_diff
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.errors import GitError, InvalidOptionError
from mirage.commands.cli.builtin.git.revparse import resolve_commit
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.util import check_operands, fatal
from mirage.commands.cli.types import CLIInvocation, CLIVerbOpts
from mirage.commands.spec.types import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult

HEAD = "HEAD"

# Deliberate divergence, verified against git 2.47.3 on a real
# repository. The patch is correct and applies cleanly, and file
# headers, mode lines and blob abbreviations match git exactly, but the
# hunks are not byte-identical:
#
#   ours: @@ -3,6 +3,10 @@
#   git:  @@ -4,6 +4,10 @@ from collections import defaultdict
#
# Two causes, both from dulwich rendering through Python's difflib
# rather than git's xdiff. git appends the enclosing function or section
# to a hunk header (xfuncname), and git slides a hunk to the equivalent
# boundary xdiff prefers, so a blank line can be attributed to the
# additions on one side and the context on the other. Closing this means
# reimplementing xdl_change_compact and the xfuncname scan; until then
# do not claim byte parity for diff bodies. `log`, `log --oneline`,
# `show`'s header and `branch` ARE byte-identical.


def _render(repo: BaseRepo, old_rev: str, new_rev: str) -> bytes:
    """Resolve both revisions and render the patch, synchronously.

    Runs on a worker thread, because resolving and reading blobs both
    fetch through the dispatcher.

    Args:
        repo (BaseRepo): repository to read.
        old_rev (str): the revision on the minus side.
        new_rev (str): the revision on the plus side.
    """
    old = resolve_commit(repo, old_rev)
    new = resolve_commit(repo, new_rev)
    out = BytesIO()
    write_tree_diff(out, repo.object_store, old.tree, new.tree)
    return out.getvalue()


async def diff(inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    """Diff two commits.

    One revision diffs it against HEAD's tree, two diff against each
    other. The working tree is not a party to this yet: comparing
    against it needs the index and the worktree scan, which is where
    unstaged and staged diffs live.

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
    if not texts:
        return None, IOResult()
    try:
        check_operands(texts, InvalidOptionError)
        repo, _location = await opened(fl, stat_path, mount_root, dispatch)
        new_rev = texts[1] if len(texts) >= 2 else HEAD
        body = await asyncio.to_thread(_render, repo, texts[0], new_rev)
    except GitError as exc:
        return fatal(exc)
    if not body:
        return None, IOResult()
    return yield_bytes(body), IOResult()
