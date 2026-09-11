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

from mirage.io.types import materialize
from mirage.shell.errors import ArithError, ExitSignal
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.dates import iso_timestamp
from mirage.utils.path import CycleError, resolve_path, resolve_symlinks
from mirage.workspace.executor.builtins.condition.constants import (
    FILE_PAIR_BINARY, FILE_UNARY, INT_COMPARATORS, UNSUPPORTED_UNARY)
from mirage.workspace.executor.builtins.condition.types import (CondContext,
                                                                CondError)
from mirage.workspace.executor.builtins.links import resolve_path_stat
from mirage.workspace.executor.builtins.scope import _scope_path, _to_scope
from mirage.workspace.session.elements import element_is_set


def operand_scope(ctx: CondContext, val: str | PathSpec) -> PathSpec:
    """Resolve a file operand to an addressable scope.

    Args:
        ctx (CondContext): evaluation context.
        val (str | PathSpec): operand as typed or classified.
    """
    if isinstance(val, PathSpec):
        return val
    resolved = resolve_path(val, ctx.session.cwd)
    resolved = resolve_symlinks(resolved, ctx.namespace.symlink_targets())
    return _to_scope(resolved)


async def path_kind(ctx: CondContext,
                    val: str | PathSpec) -> tuple[str | None, FileStat | None]:
    """Resolve an operand to 'dir' / 'file' / None plus its stat.

    Symlinks are followed first (test -e/-f/-d act on the target), then
    ``resolve_path_stat`` answers what is there. That probe is shared with
    ``find`` and ``tree``'s start point, so ``test -d`` and a traversal
    cannot disagree about whether a path exists.

    Args:
        ctx (CondContext): evaluation context.
        val (str | PathSpec): operand as typed or classified.
    """
    try:
        scope = operand_scope(ctx, val)
    except CycleError:
        # A link loop names nothing: stat fails with ELOOP and bash reads
        # that as absent (`[ loop -ef loop ]` and `[ -e loop ]` are
        # false), so a file test answers false rather than erroring.
        return None, None
    stat = await resolve_path_stat(ctx.dispatch, scope)
    if stat is None:
        return None, None
    if stat.type == FileType.DIRECTORY:
        return "dir", stat
    if stat.type == FileType.CHAR_DEVICE:
        return "char", stat
    return "file", stat


async def apply_unary(ctx: CondContext, op: str, val: str | PathSpec) -> bool:
    """Evaluate a unary operator.

    Args:
        ctx (CondContext): evaluation context.
        op (str): operator token, e.g. ``-n`` or ``-e``.
        val (str | PathSpec): operand.
    """
    text = _scope_path(val)
    if op == "-n":
        return text != ""
    if op == "-z":
        return text == ""
    if op == "-v":
        try:
            return await element_is_set(ctx.session, text, ctx.view)
        except ArithError as exc:
            # bash aborts the line on `[[ -v a[1/0] ]]` with `1/0:
            # division by 0`, a test's grammar error being the only
            # other thing that ends it.
            raise ExitSignal(1,
                             stderr=f"bash: {exc}\n".encode(),
                             contained_code=1) from exc
    if op in ("-L", "-h"):
        resolved = resolve_path(text, ctx.session.cwd)
        return ctx.namespace.is_link(resolved)
    if op in FILE_UNARY:
        if not isinstance(val, PathSpec) and not text:
            return False
        kind, stat = await path_kind(ctx, val)
        if op == "-e":
            return kind is not None
        if op == "-f":
            return kind == "file"
        if op == "-d":
            return kind == "dir"
        if op == "-c":
            return kind == "char"
        if op == "-s":
            if kind == "dir":
                return True
            if kind != "file" or stat is None:
                return False
            if stat.size is not None:
                return stat.size > 0
            # API backends (dropbox, gdrive, box) stat freshly written
            # empty files as size-unknown; only a read can answer, and
            # the prefetch TTL cache keeps repeat tests cheap.
            data, _ = await ctx.dispatch("read", operand_scope(ctx, val))
            return len(await materialize(data)) > 0
        if op in ("-r", "-w"):
            # Mirage has no per-user access model: whatever exists in a
            # mount is readable and writable through it.
            return kind is not None
        if op == "-x":
            if kind == "dir":
                return True
            if kind != "file" or stat is None:
                return False
            return stat.mode is not None and bool(stat.mode & 0o111)
    if op in UNSUPPORTED_UNARY:
        raise CondError(f"{ctx.name}: {op}: unsupported operator")
    raise CondError(f"{ctx.name}: {op}: unary operator expected")


def to_int(ctx: CondContext, text: str) -> int:
    """Parse a test integer operand, with bash's diagnostic.

    Args:
        ctx (CondContext): evaluation context.
        text (str): operand text.
    """
    try:
        return int(text.strip())
    except ValueError:
        raise CondError(f"{ctx.name}: {text}: integer expression expected")


async def apply_binary(ctx: CondContext, left: str | PathSpec, op: str,
                       right: str | PathSpec) -> bool:
    """Evaluate a test/[ binary operator (literal string semantics).

    Args:
        ctx (CondContext): evaluation context.
        left (str | PathSpec): left operand.
        op (str): operator token.
        right (str | PathSpec): right operand.
    """
    lt = _scope_path(left)
    rt = _scope_path(right)
    if op in ("=", "=="):
        return lt == rt
    if op == "!=":
        return lt != rt
    compare = INT_COMPARATORS.get(op)
    if compare is not None:
        return compare(to_int(ctx, lt), to_int(ctx, rt))
    if op in FILE_PAIR_BINARY:
        return await apply_file_pair(ctx, op, left, right)
    raise CondError(f"{ctx.name}: {op}: binary operator expected")


async def _pair_stat(ctx: CondContext, val: str | PathSpec) -> FileStat | None:
    """Stat one file-pair operand, None when it names nothing.

    An empty word names nothing, as it does for the unary file tests.

    Args:
        ctx (CondContext): evaluation context.
        val (str | PathSpec): operand as typed or classified.
    """
    if not isinstance(val, PathSpec) and not _scope_path(val):
        return None
    _, stat = await path_kind(ctx, val)
    return stat


async def apply_file_pair(ctx: CondContext, op: str, left: str | PathSpec,
                          right: str | PathSpec) -> bool:
    """Evaluate ``-nt``, ``-ot`` and ``-ef``, with bash's absence rules.

    ``-nt`` is true when the left file exists and either the right does
    not or the left's mtime is strictly later; ``-ot`` is the mirror.
    Equal mtimes, or one the backend does not report, make both false.
    ``-ef`` is true when both exist and resolve, symlinks followed, to
    the same virtual path: mirage has no device and inode pair, and a
    path names exactly one entry across the mount table, so the resolved
    spelling is the identity. Pinned against GNU bash 5.2.

    Args:
        ctx (CondContext): evaluation context.
        op (str): ``-nt``, ``-ot`` or ``-ef``.
        left (str | PathSpec): left operand.
        right (str | PathSpec): right operand.
    """
    lstat = await _pair_stat(ctx, left)
    rstat = await _pair_stat(ctx, right)
    if op == "-ef":
        if lstat is None or rstat is None:
            return False
        return (operand_scope(ctx, left).virtual.rstrip("/") == operand_scope(
            ctx, right).virtual.rstrip("/"))
    if op == "-ot":
        lstat, rstat = rstat, lstat
    if lstat is None:
        return False
    if rstat is None:
        return True
    lt = iso_timestamp(lstat.modified)
    rt = iso_timestamp(rstat.modified)
    return lt is not None and rt is not None and lt > rt
