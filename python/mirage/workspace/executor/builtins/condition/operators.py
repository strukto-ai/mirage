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
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.path import resolve_path, resolve_symlinks
from mirage.workspace.executor.builtins.condition.constants import (
    FILE_PAIR_BINARY, FILE_UNARY, INT_COMPARATORS, UNSUPPORTED_UNARY)
from mirage.workspace.executor.builtins.condition.types import (CondContext,
                                                                CondError)
from mirage.workspace.executor.builtins.links import resolve_path_stat
from mirage.workspace.executor.builtins.scope import _scope_path, _to_scope


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
    stat = await resolve_path_stat(ctx.dispatch, operand_scope(ctx, val))
    if stat is None:
        return None, None
    if stat.type == FileType.DIRECTORY:
        return "dir", stat
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
        raise CondError(f"{ctx.name}: {op}: unsupported operator")
    raise CondError(f"{ctx.name}: {op}: binary operator expected")
