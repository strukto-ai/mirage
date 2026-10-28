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

from functools import partial

from mirage.commands.builtin.utils.paths import (
    dispatch_stat,
    dot_refusal,
    resolve_path_stat,
)
from mirage.context.session_context import (
    effective_path_mode,
    session_access,
)
from mirage.errors.types import FileTooLargeError
from mirage.io.types import materialize
from mirage.policy import PolicyDenied
from mirage.shell.constants import SET_OPTION_DEFAULTS, SET_OPTION_NAMES
from mirage.shell.errors import ArithError
from mirage.types import FileStat, FileType, MountMode, PathSpec
from mirage.utils.dates import iso_timestamp
from mirage.utils.path import CycleError, dotted_spelling, resolve_path
from mirage.workspace.executor.builtins.condition.constants import (
    FILE_PAIR_BINARY,
    FILE_UNARY,
    INT_COMPARATORS,
)
from mirage.workspace.executor.builtins.condition.types import (
    CondContext,
    CondError,
)
from mirage.workspace.executor.builtins.links import follow_paths
from mirage.workspace.executor.builtins.scope import _scope_path, _to_scope
from mirage.workspace.executor.builtins.shared import abs_path
from mirage.workspace.session.elements import element_is_set
from mirage.workspace.session.state import nameref_target


def operand_scope(ctx: CondContext, val: str | PathSpec) -> PathSpec:
    """Resolve a file operand to an addressable scope, its links
    followed.

    A builtin's operand never passes the router's pathname walk, so it
    is walked here, typed or classified alike (a classified one by the
    spelling its dots need): ``-ef`` compares where two names lead.

    Args:
        ctx (CondContext): evaluation context.
        val (str | PathSpec): operand as typed or classified.
    """
    if isinstance(val, PathSpec):
        if val.walk_error is not None:
            # The walk already refused it (the empty name, a link loop):
            # it names nothing, which the dispatcher answers.
            return val
        spelled = val.dotted or val.virtual
    else:
        spelled = dotted_spelling(val, ctx.session.cwd) or resolve_path(
            val, ctx.session.cwd
        )
    return _to_scope(
        ctx.links.resolve(spelled) if ctx.links is not None else spelled
    )


async def path_kind(
    ctx: CondContext, val: str | PathSpec
) -> tuple[str | None, FileStat | None]:
    """Resolve an operand to 'dir' / 'file' / 'char' / 'fifo' / 'block' /
    'socket' / None plus its stat.

    Symlinks are followed first (test -e/-f/-d act on the target), then
    ``resolve_path_stat`` answers what is there. That probe is shared with
    ``find`` and ``tree``'s start point, so ``test -d`` and a traversal
    cannot disagree about whether a path exists. A FIFO is no regular file
    and stores nothing, so ``-f`` and ``-s`` are false for one (GNU: ``[ -s
    <(printf x) ]``).

    Args:
        ctx (CondContext): evaluation context.
        val (str | PathSpec): operand as typed or classified.
    """
    walk = PathSpec.from_str_path(val, cwd=ctx.session.cwd)
    try:
        if (
            await dot_refusal(
                partial(dispatch_stat, ctx.dispatch),
                walk,
                ctx.namespace.session_links(ctx.session).follow,
            )
            is not None
        ):
            # A path whose `.` and `..` do not resolve names nothing, which
            # is what every file test reads as false.
            return None, None
        try:
            scope = operand_scope(ctx, val)
        except CycleError:
            # A link loop names nothing: stat fails with ELOOP and bash
            # reads that as absent (`[ loop -ef loop ]` and `[ -e loop ]`
            # are false), so a file test answers false rather than erroring.
            return None, None
        stat = await resolve_path_stat(ctx.dispatch, scope)
    except PolicyDenied:
        raise
    except PermissionError:
        # bash reads a file test whose stat, or a stat on the way to it,
        # a store refuses as false.
        return None, None
    if stat is None:
        return None, None
    if stat.type == FileType.DIRECTORY:
        return "dir", stat
    if stat.type == FileType.CHAR_DEVICE:
        return "char", stat
    if stat.type == FileType.FIFO:
        return "fifo", stat
    if stat.type == FileType.BLOCK_DEVICE:
        return "block", stat
    if stat.type == FileType.SOCKET:
        return "socket", stat
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
            raise exc.signal(fatal=True) from exc
    if op == "-R":
        return nameref_target(ctx.session, text) is not None
    if op == "-o":
        return text in SET_OPTION_NAMES and ctx.session.shell_options.get(
            text, SET_OPTION_DEFAULTS[text]
        )
    if op == "-t":
        # No descriptor of a mirage line is a terminal.
        return False
    if op in ("-L", "-h"):
        if not isinstance(val, PathSpec) and not text:
            return False
        # A builtin's operand never passes the router's pathname walk, so
        # it is walked here as the router walks one whose last name
        # lstat(2) keeps: a link above it resolves, and so does the last
        # name of one typed with a trailing slash.
        spec = (
            val
            if isinstance(val, PathSpec)
            else PathSpec.from_str_path(val, cwd=ctx.session.cwd)
        )
        links = ctx.namespace.session_links(ctx.session)
        (walked,) = follow_paths(links, [spec], follow_last=False)
        if isinstance(walked, PathSpec) and walked.walk_error is not None:
            return False
        where = abs_path(walked, ctx.session.cwd)
        return ctx.links is not None and ctx.links.stat_at(where) is not None
    if op in FILE_UNARY:
        if not isinstance(val, PathSpec) and not text:
            return False
        kind, stat = await path_kind(ctx, val)
        if op in ("-e", "-a"):
            return kind is not None
        if op == "-f":
            return kind == "file"
        if op == "-d":
            return kind == "dir"
        if op == "-c":
            return kind == "char"
        if op == "-p":
            return kind == "fifo"
        if op == "-b":
            return kind == "block"
        if op == "-S":
            return kind == "socket"
        if op in ("-O", "-G"):
            # Mirage has one user, who owns every entry it reaches, as
            # every entry it reaches is readable (`-r`).
            return kind is not None
        if op in ("-u", "-g", "-k"):
            bit = {"-u": 0o4000, "-g": 0o2000, "-k": 0o1000}[op]
            return (
                stat is not None
                and stat.mode is not None
                and bool(stat.mode & bit)
            )
        if op == "-N":
            # Modified since last read: a write later than the last
            # access, which only a store that keeps both times can say.
            if stat is None:
                return False
            written = iso_timestamp(stat.modified)
            read = iso_timestamp(stat.atime)
            return written is not None and read is not None and written > read
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
            try:
                data, _ = await ctx.dispatch("read", operand_scope(ctx, val))
            except FileTooLargeError:
                # a file its mount refuses to render whole (an airtable
                # table past max_read_records) is certainly not empty
                return True
            return len(await materialize(data)) > 0
        if op == "-r":
            # Mirage has no per-user access model: whatever exists in a
            # mount is readable through it.
            return kind is not None
        if op == "-w":
            return kind is not None and writable(ctx, val)
        if op == "-x":
            if kind == "dir":
                return True
            if kind not in ("file", "fifo") or stat is None:
                return False
            return stat.mode is not None and bool(stat.mode & 0o111)
    raise CondError(f"{ctx.name}: {op}: unary operator expected")


def writable(ctx: CondContext, val: str | PathSpec) -> bool:
    """Whether a write at an operand would be admitted by mode: the mode
    in force there for the session (``effective_path_mode``), which is
    what the write itself meets, so ``test -w`` never says yes to a
    write that then answers EROFS, as access(2) answers on a read-only
    file system. A path no mount owns takes no write.

    Args:
        ctx (CondContext): evaluation context.
        val (str | PathSpec): operand as typed or classified.
    """
    virtual = operand_scope(ctx, val).virtual
    mount = ctx.namespace.try_mount_for(virtual)
    if mount is None:
        return False
    mode = effective_path_mode(
        virtual, mount.prefix, mount.mode, session_access(ctx.session)
    )
    return mode is not MountMode.READ


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


async def apply_binary(
    ctx: CondContext, left: str | PathSpec, op: str, right: str | PathSpec
) -> bool:
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
    if op == "<":
        return lt < rt
    if op == ">":
        return lt > rt
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


async def apply_file_pair(
    ctx: CondContext, op: str, left: str | PathSpec, right: str | PathSpec
) -> bool:
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
        return operand_scope(ctx, left).virtual.rstrip("/") == operand_scope(
            ctx, right
        ).virtual.rstrip("/")
    if op == "-ot":
        lstat, rstat = rstat, lstat
    if lstat is None:
        return False
    if rstat is None:
        return True
    lt = iso_timestamp(lstat.modified)
    rt = iso_timestamp(rstat.modified)
    return lt is not None and rt is not None and lt > rt
