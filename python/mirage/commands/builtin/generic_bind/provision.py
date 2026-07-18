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

import logging
from collections.abc import Callable
from typing import Any

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.grep_helper import BINARY_EXTENSIONS
from mirage.commands.resolve import get_extension
from mirage.core.jq import is_jsonl_path, is_streamable_jsonl_expr
from mirage.provision.types import Precision, ProvisionResult
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import rekey

logger = logging.getLogger(__name__)

# Cap on entries visited by a planning walk (grep -r): beyond it the
# estimate degrades to an UNKNOWN floor instead of walking forever.
MAX_PLAN_WALK = 1000


async def _expand_globs(
    resolve_glob: Callable[..., Any] | None,
    accessor: Accessor,
    paths: list[PathSpec],
    index: IndexCacheStore,
) -> list[PathSpec]:
    """Expand glob operands the way the executor would.

    Without a resolver (or on any backend error) the original paths are
    returned, whose pattern entries then stat-fail into UNKNOWN floors,
    which is the pre-expansion behavior.
    """
    if resolve_glob is None:
        return paths
    if not any(isinstance(p, PathSpec) and p.pattern for p in paths):
        return paths
    try:
        return await resolve_glob(accessor, paths, index)
    except Exception as exc:
        logger.debug("provision glob expansion failed: %s", exc)
        return paths


async def _walk_files(
    readdir: Callable[..., Any],
    stat: Callable[..., Any],
    accessor: Accessor,
    roots: list[PathSpec],
    index: IndexCacheStore,
) -> tuple[list[tuple[str, int]], bool]:
    """Walk directories the way grep -r does, collecting file sizes.

    Directories recurse; files skipped by the executor (columnar
    BINARY_EXTENSIONS) are skipped here too so the estimate matches
    what the run would read. Returns (sized files, complete): complete
    is False when the walk was capped or any entry failed to resolve,
    in which case the totals are only floors.
    """
    sized: list[tuple[str, int]] = []
    complete = True
    visited = 0
    queue: list[PathSpec] = list(roots)
    while queue:
        p = queue.pop(0)
        visited += 1
        if visited > MAX_PLAN_WALK:
            return sized, False
        try:
            s = await stat(accessor, p, index)
        except Exception as exc:
            logger.debug("provision walk stat failed for %s: %s", p.virtual,
                         exc)
            complete = False
            continue
        if s.type == FileType.DIRECTORY:
            try:
                entries = await readdir(accessor, p, index)
            except Exception as exc:
                logger.debug("provision walk readdir failed for %s: %s",
                             p.virtual, exc)
                complete = False
                continue
            queue.extend(
                PathSpec.from_str_path(e, rekey(p.virtual, p.resource_path, e))
                for e in entries)
            continue
        if get_extension(p.virtual) in BINARY_EXTENSIONS:
            continue
        if s.size is None:
            complete = False
            continue
        sized.append((p.virtual, s.size))
    return sized, complete


async def _resolve_sizes(
    stat: Callable[..., Any],
    accessor: Accessor,
    paths: list[PathSpec],
    index: IndexCacheStore,
) -> tuple[list[tuple[str, int]], int]:
    resolved: list[tuple[str, int]] = []
    missing = 0
    for p in paths:
        path_str = p.virtual if isinstance(p, PathSpec) else p
        size = None
        lookup = await index.get(path_str)
        if lookup.entry is not None:
            size = lookup.entry.size
        if size is None:
            # A provision estimate must degrade, never fail: any stat
            # error (missing file, transient backend error) leaves the
            # path unresolved and the result UNKNOWN (mirrors TS).
            try:
                file_stat = await stat(accessor, p, index)
                size = file_stat.size
            except Exception as exc:
                logger.debug("provision stat failed for %s: %s", path_str, exc)
        if size is not None:
            resolved.append((path_str, size))
        else:
            missing += 1
    return resolved, missing


def make_file_read_provision(
        stat: Callable[..., Any],
        resolve_glob: Callable[..., Any] | None = None) -> Callable[..., Any]:
    """Cost estimate for full file reads (cat, wc), generic over stat."""

    async def file_read_provision(
        accessor: Accessor,
        paths: list[PathSpec],
        *_args: str,
        command: str = "",
        index: IndexCacheStore = NULL_INDEX,
        **kwargs,
    ) -> ProvisionResult:
        if not paths:
            # Pathless invocations are stdin-driven (pipe stage, heredoc,
            # or an immediate missing-operand error): zero backend bytes.
            return ProvisionResult(command=command, precision=Precision.EXACT)
        paths = await _expand_globs(resolve_glob, accessor, paths, index)
        if not paths:
            return ProvisionResult(command=command,
                                   precision=Precision.UNKNOWN)
        resolved, missing = await _resolve_sizes(stat, accessor, paths, index)
        total = sum(size for _, size in resolved)
        if missing > 0 or not resolved:
            # Sizes we could not resolve (virtual/rendered files) are
            # carried as UNKNOWN precision; the totals are floors.
            return ProvisionResult(
                command=command,
                network_read_low=total,
                network_read_high=total,
                read_ops=len(paths),
                precision=Precision.UNKNOWN,
            )
        return ProvisionResult(
            command=command,
            network_read_low=total,
            network_read_high=total,
            read_ops=len(resolved),
            precision=Precision.EXACT,
        )

    return file_read_provision


def make_head_tail_provision(
        stat: Callable[..., Any],
        resolve_glob: Callable[..., Any] | None = None) -> Callable[..., Any]:
    """Cost estimate for partial reads (head, tail), generic over stat."""

    async def head_tail_provision(
        accessor: Accessor,
        paths: list[PathSpec],
        *_args: str,
        command: str = "",
        n: str | int | None = None,
        c: str | int | None = None,
        index: IndexCacheStore = NULL_INDEX,
        **kwargs,
    ) -> ProvisionResult:
        if not paths:
            # Pathless invocations are stdin-driven (pipe stage, heredoc,
            # or an immediate missing-operand error): zero backend bytes.
            return ProvisionResult(command=command, precision=Precision.EXACT)
        paths = await _expand_globs(resolve_glob, accessor, paths, index)
        if not paths:
            return ProvisionResult(command=command,
                                   precision=Precision.UNKNOWN)
        resolved, missing = await _resolve_sizes(stat, accessor, paths, index)
        if missing > 0 or not resolved:
            full = sum(size for _, size in resolved)
            return ProvisionResult(
                command=command,
                network_read_low=0,
                network_read_high=full,
                read_ops=len(paths),
                precision=Precision.UNKNOWN,
            )
        # A byte-count -c only; boolean -c flags (e.g. file -c) don't cap.
        if c is not None and not isinstance(c, bool):
            c_bytes = int(c)
            total = sum(min(c_bytes, size) for _, size in resolved)
            return ProvisionResult(
                command=command,
                network_read_low=total,
                network_read_high=total,
                read_ops=len(resolved),
                precision=Precision.EXACT,
            )
        full = sum(size for _, size in resolved)
        return ProvisionResult(
            command=command,
            network_read_low=0,
            network_read_high=full,
            read_ops=len(resolved),
            precision=Precision.RANGE,
        )

    return head_tail_provision


async def metadata_provision(
    accessor: Accessor,
    paths: list[PathSpec],
    *_args: str,
    command: str = "",
    index: IndexCacheStore = NULL_INDEX,
    **kwargs,
) -> ProvisionResult:
    """Cost estimate for metadata-only ops (stat, ls, find)."""
    n = max(1, len(paths) if paths else 1)
    return ProvisionResult(
        command=command,
        network_read_low=0,
        network_read_high=0,
        read_ops=n,
        precision=Precision.EXACT,
    )


async def exact_zero_provision(command: str = "") -> ProvisionResult:
    """Zero-cost EXACT estimate for backends whose listing is in memory.

    Chat/KB backends materialize their virtual tree from state the mount
    already fetched, so metadata commands cost no backend I/O at all
    (unlike :func:`metadata_provision`, which charges one op per operand).

    Args:
        command (str): the shell line being estimated, for display.
    """
    return ProvisionResult(
        command=command,
        network_read_low=0,
        network_read_high=0,
        read_ops=0,
        precision=Precision.EXACT,
    )


async def index_hit_read_provision(
    accessor: Accessor,
    paths: list[PathSpec],
    command: str,
    index: IndexCacheStore = NULL_INDEX,
) -> ProvisionResult:
    """Charge one read op per index-cached operand, zero network bytes.

    The chat backends (discord, slack, ...) rebuild file bytes from API
    state, so a read costs ops rather than sized transfers; operands the
    index has never seen leave the estimate UNKNOWN.

    Args:
        accessor (Accessor): backend handle, unused but part of the
            provision call shape.
        paths (list[PathSpec]): operand paths as parsed.
        command (str): the shell line being estimated, for display.
        index (IndexCacheStore): the per-call cache index.
    """
    if not paths:
        return ProvisionResult(command=command, precision=Precision.UNKNOWN)
    ops = 0
    for p in paths:
        path_str = p.virtual if isinstance(p, PathSpec) else p
        lookup = await index.get(path_str)
        if lookup.entry is not None:
            ops += 1
    return ProvisionResult(
        command=command,
        network_read_low=0,
        network_read_high=0,
        read_ops=ops,
        precision=Precision.EXACT,
    )


def make_jq_provision(stat: Callable[..., Any]) -> Callable[..., Any]:
    """Provision for jq: streamable jsonl reads a range, else whole file."""

    async def jq_provision(
        accessor: Accessor,
        paths: list[PathSpec] | None = None,
        *texts: str,
        index: IndexCacheStore = NULL_INDEX,
        **kwargs,
    ) -> ProvisionResult:
        if not paths:
            # A pathless jq filters stdin (or errors without an expr):
            # zero backend bytes either way.
            return ProvisionResult(command="jq", precision=Precision.EXACT)
        if not texts:
            return ProvisionResult(command="jq", precision=Precision.UNKNOWN)
        p = paths[0]
        key = p.mount_path if isinstance(p, PathSpec) else p
        try:
            file_stat = await stat(accessor, p, index)
        except Exception as exc:
            logger.debug("provision stat failed for %s: %s", key, exc)
            return ProvisionResult(command="jq", precision=Precision.UNKNOWN)
        expr = texts[0]
        shown = p.virtual if isinstance(p, PathSpec) else p
        rendered = f"jq {expr!r} {shown}"
        if file_stat.size is None:
            return ProvisionResult(command=rendered,
                                   read_ops=1,
                                   precision=Precision.UNKNOWN)
        file_size = file_stat.size
        if is_jsonl_path(key) and is_streamable_jsonl_expr(expr):
            return ProvisionResult(
                command=rendered,
                network_read_low=0,
                network_read_high=file_size,
                read_ops=1,
                precision=Precision.RANGE,
            )
        return ProvisionResult(
            command=rendered,
            network_read_low=file_size,
            network_read_high=file_size,
            read_ops=1,
            precision=Precision.EXACT,
        )

    return jq_provision


def make_sed_provision(stat: Callable[..., Any]) -> Callable[..., Any]:
    """Provision for sed: operands are read fully; -i writes back, so
    the output keeps the read total as a floor with UNKNOWN."""
    base = make_file_read_provision(stat)

    async def sed_provision(
        accessor: Accessor,
        paths: list[PathSpec],
        *_args: str,
        command: str = "",
        i: bool = False,
        index: IndexCacheStore = NULL_INDEX,
        **kwargs,
    ) -> ProvisionResult:
        result = await base(accessor, paths, command=command, index=index)
        if i:
            result.precision = Precision.UNKNOWN
        return result

    return sed_provision


def make_search_provision(
        stat: Callable[..., Any],
        resolve_glob: Callable[..., Any] | None = None,
        readdir: Callable[..., Any] | None = None) -> Callable[..., Any]:
    """Provision for grep/rg/jq: render pattern then delegate to file_read.

    With -r/-R and a readdir, directory operands are walked the way the
    executor walks them (recursing subdirectories, skipping columnar
    files), so a recursive search over an indexed tree prices exactly.
    """
    base = make_file_read_provision(stat, resolve_glob)

    async def search_provision(
        accessor: Accessor,
        paths: list[PathSpec],
        *texts: str,
        command: str = "",
        index: IndexCacheStore = NULL_INDEX,
        r: bool = False,
        R: bool = False,
        **kwargs,
    ) -> ProvisionResult:
        rendered = (command or ""
                    ) + " " + " ".join(list(texts) + [str(p) for p in paths])
        if (r or R) and readdir is not None and paths:
            roots = await _expand_globs(resolve_glob, accessor, paths, index)
            sized, complete = await _walk_files(readdir, stat, accessor, roots,
                                                index)
            total = sum(size for _, size in sized)
            if not complete or not sized:
                return ProvisionResult(
                    command=rendered,
                    network_read_low=total,
                    network_read_high=total,
                    read_ops=max(len(sized), len(paths)),
                    precision=Precision.UNKNOWN,
                )
            return ProvisionResult(
                command=rendered,
                network_read_low=total,
                network_read_high=total,
                read_ops=len(sized),
                precision=Precision.EXACT,
            )
        return await base(accessor, paths, command=rendered, index=index)

    return search_provision


def make_transform_provision(
        stat: Callable[..., Any],
        resolve_glob: Callable[..., Any] | None = None) -> Callable[..., Any]:
    """Provision for read-transform-write commands (gzip, tar, split).

    The operands are read fully, so the read side is a known floor, but
    the output size (compression ratio, piece count) is unknowable
    before running, so precision stays UNKNOWN.
    """
    base = make_file_read_provision(stat, resolve_glob)

    async def transform_provision(
        accessor: Accessor,
        paths: list[PathSpec],
        *_args: str,
        command: str = "",
        index: IndexCacheStore = NULL_INDEX,
        **kwargs,
    ) -> ProvisionResult:
        result = await base(accessor, paths, command=command, index=index)
        if paths:
            # Output size (compression ratio, piece count) is unknowable.
            # A pathless transform filters stdin to stdout: exact zero.
            result.precision = Precision.UNKNOWN
        return result

    return transform_provision


def make_copy_provision(
        stat: Callable[..., Any],
        resolve_glob: Callable[..., Any] | None = None) -> Callable[..., Any]:
    """Provision for cp: bytes bracket 0 (server-side copy) to the total.

    Reads the source sizes and reports both network_read and
    network_write as a 0..total range: a same-backend copy can be
    server-side (zero client bytes) while a streamed copy moves the
    full byte count each way.
    """

    async def copy_provision(
        accessor: Accessor,
        paths: list[PathSpec],
        *_args: str,
        command: str = "",
        index: IndexCacheStore = NULL_INDEX,
        **kwargs,
    ) -> ProvisionResult:
        paths = await _expand_globs(resolve_glob, accessor, paths, index)
        sources = paths[:-1] if len(paths) > 1 else paths
        if not sources:
            return ProvisionResult(command=command,
                                   precision=Precision.UNKNOWN)
        resolved, missing = await _resolve_sizes(stat, accessor, sources,
                                                 index)
        total = sum(size for _, size in resolved)
        precision = (Precision.UNKNOWN
                     if missing > 0 or not resolved else Precision.RANGE)
        return ProvisionResult(
            command=command,
            network_read_low=0,
            network_read_high=total,
            network_write_low=0,
            network_write_high=total,
            read_ops=len(sources),
            precision=precision,
        )

    return copy_provision


async def write_metadata_provision(
    accessor: Accessor,
    paths: list[PathSpec],
    *_args: str,
    command: str = "",
    r: bool = False,
    R: bool = False,
    index: IndexCacheStore = NULL_INDEX,
    **kwargs,
) -> ProvisionResult:
    """Provision for metadata-only writes (rm, mkdir, touch, ln).

    These never move content bytes on any backend; the op count is the
    operand count. A recursive rm walks an unknown subtree, so its op
    count is only a floor and precision degrades to UNKNOWN.
    """
    n = max(1, len(paths) if paths else 1)
    precision = Precision.UNKNOWN if r or R else Precision.EXACT
    return ProvisionResult(
        command=command,
        network_read_low=0,
        network_read_high=0,
        read_ops=n,
        precision=precision,
    )


async def pure_provision(
    accessor: Accessor,
    paths: list[PathSpec],
    *_args: str,
    command: str = "",
    **kwargs,
) -> ProvisionResult:
    """Provision for pure local computation (seq, date, bc): zero cost."""
    return ProvisionResult(command=command, precision=Precision.EXACT)


FILE_READ_COMMANDS = frozenset({
    "awk", "base64", "cat", "cmp", "column", "comm", "cut", "diff", "expand",
    "fmt", "fold", "iconv", "join", "look", "md5", "nl", "paste", "rev",
    "sha256sum", "shuf", "sort", "strings", "tac", "tr", "tsort", "unexpand",
    "uniq", "wc", "xxd", "zcat"
})
# file reads a bounded prefix (magic bytes), so it shares head/tail's
# 0..size range estimate.
HEAD_TAIL_COMMANDS = frozenset({"file", "head", "tail"})
SEARCH_COMMANDS = frozenset({"grep", "rg", "zgrep"})
METADATA_COMMANDS = frozenset({
    "basename", "dirname", "du", "find", "ls", "readlink", "realpath", "stat",
    "tree"
})
TRANSFORM_COMMANDS = frozenset(
    {"csplit", "gunzip", "gzip", "patch", "split", "tar", "unzip", "zip"})
WRITE_METADATA_COMMANDS = frozenset({"ln", "mkdir", "mktemp", "rm", "touch"})


def default_provision(
        name: str,
        stat: Callable[..., Any],
        resolve_glob: Callable[..., Any] | None = None,
        readdir: Callable[..., Any] | None = None
) -> Callable[..., Any] | None:
    """Default cost estimator for a factory-built command, by family.

    Whole-file readers stat their operands and charge the byte total;
    searches charge a worst-case full read; metadata commands charge op
    counts only; transforms keep the read floor with UNKNOWN output;
    cp brackets 0..total on both read and write; metadata writes are
    zero-byte op counts. mv, tee, and anything unlisted return None so
    the planner reports UNKNOWN (mv may be a free rename or a full
    cross-mount copy; tee's stdin size is unknowable). A backend
    disables a default by passing an explicit None in
    provision_overrides.

    Args:
        name (str): Builder/command name.
        stat (Callable): Backend stat used to resolve operand sizes.
        resolve_glob (Callable | None): Backend glob resolver; byte
            estimators expand pattern operands with it instead of
            flooring them to UNKNOWN.
        readdir (Callable | None): Backend readdir; recursive searches
            walk directories with it for exact totals.

    Returns:
        Callable | None: Provision function, or None when the family has
        no sensible generic estimate.
    """
    if name in FILE_READ_COMMANDS:
        return make_file_read_provision(stat, resolve_glob)
    if name in HEAD_TAIL_COMMANDS:
        return make_head_tail_provision(stat, resolve_glob)
    if name in SEARCH_COMMANDS:
        return make_search_provision(stat, resolve_glob, readdir)
    if name in METADATA_COMMANDS:
        return metadata_provision
    if name in TRANSFORM_COMMANDS:
        return make_transform_provision(stat, resolve_glob)
    if name in WRITE_METADATA_COMMANDS:
        return write_metadata_provision
    if name == "cp":
        return make_copy_provision(stat, resolve_glob)
    if name == "jq":
        return make_jq_provision(stat)
    return None
