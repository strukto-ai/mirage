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
from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.grep import grep_generic
from mirage.commands.builtin.generic.rg import (
    folds_case,
    rg_generic,
    rg_syntax,
)
from mirage.commands.builtin.generic.rg import parse_flags as parse_rg_flags
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.grep_pattern import (
    PATTERN_KEYS,
    matcher_syntax,
    pattern_arg,
)
from mirage.commands.builtin.grep_pushdown import (
    grep_search_meta,
    literal_pushdown_operand,
    pushdown_operand,
    text_candidates,
    text_search_results,
    whole_word_literal,
)
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.config import CommandIO, CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.doors.namespace_view import paths_scoped
from mirage.errors.types import FileTooLargeError
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import utf8_locale
from mirage.types import FileType, JsonValue, PathSpec
from mirage.vfs.types import SearchQuery

logger = logging.getLogger(__name__)

_GENERICS = {"grep": grep_generic, "rg": rg_generic}


def search_options(
    name: str, fl: FlagView, pattern: str, utf8: bool = False
) -> dict[str, JsonValue]:
    """How a native search matches the pushed-down pattern.

    Args:
        name (str): grep or rg.
        fl (FlagView): the invocation's flags.
        pattern (str): the pattern pushed down.
        utf8 (bool): grep runs under a UTF-8 locale; ripgrep matches
            text under any.
    """
    if name == "rg":
        f = parse_rg_flags(fl)
        return {
            "ignore_case": folds_case(pattern, f.fixed_string, f),
            "fixed_string": f.fixed_string,
            "whole_word": f.whole_word,
            "syntax": rg_syntax(f).value,
        }
    return {
        "ignore_case": fl.as_bool("i"),
        "fixed_string": fl.as_bool("F"),
        "whole_word": fl.as_bool("w"),
        "syntax": matcher_syntax(fl).value,
        "utf8": utf8,
    }


def native_or_bytes(
    read_stream: Callable[[PathSpec], AsyncIterator[bytes]],
    read_bytes: Callable[[PathSpec], Awaitable[bytes]],
) -> Callable[[PathSpec], AsyncIterator[bytes]]:
    """A stream that falls back to the whole read on a first-pull failure.

    A native stream may serve only some kinds (mongodb streams
    documents.jsonl and refuses schema.json before yielding anything), so
    a failure before any data has flowed falls back to ``read_bytes``; an
    error after data has flowed is real and propagates. Mirrors the TS
    ``nativeOrBytes`` in ``generic_bind/search.ts``.

    Args:
        read_stream (Callable[[PathSpec], AsyncIterator[bytes]]): the
            bound native stream op.
        read_bytes (Callable[[PathSpec], Awaitable[bytes]]): the bound
            whole-read op the first pull falls back to.
    """

    async def stream(path: PathSpec) -> AsyncIterator[bytes]:
        it = read_stream(path).__aiter__()
        try:
            first = await it.__anext__()
        except StopAsyncIteration:
            return
        except OSError:
            yield await read_bytes(path)
            return
        yield first
        async for chunk in it:
            yield chunk

    return stream


async def run_search(
    io: CommandIO,
    name: str,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    """Run the adapter's native search, or scan for an unsupported request.

    Args:
        io (CommandIO): guarded resource operations and optional search.
        name (str): grep or rg.
        accessor (Accessor): resource handle.
        paths (list[PathSpec]): operands.
        texts (list[str]): pattern arguments.
        opts (CommandOpts): parsed invocation context.
    """
    capability = io.search
    meta = grep_search_meta(capability)
    generic = _GENERICS[name]
    fl = FlagView(opts.flags, spec=SPECS[name])
    pattern = pattern_arg(texts, fl, PATTERN_KEYS[name])
    gate = (
        literal_pushdown_operand
        if meta is not None and meta.mode == "literal"
        else pushdown_operand
    )
    operand = gate(paths, opts.flags, pattern)
    if (
        capability is not None
        and meta is not None
        and pattern is not None
        and operand is not None
        and not paths_scoped(opts.ns, [operand])
    ):
        query = SearchQuery(
            query=pattern,
            options={
                "grep": search_options(
                    name, fl, pattern, utf8_locale(opts.env)
                )
            },
        )
        try:
            lines = await capability.search(
                accessor, operand, query, opts.index
            )
        except FileTooLargeError as exc:
            # A push-down whose answer is past the mount's read cap cannot
            # print it; the scan reads each operand, and reports the same
            # refusal against the operand as typed.
            logger.debug(
                "%s push-down refused %s: %s", name, operand.virtual, exc
            )
            lines = None
        if lines is not None:
            if not lines:
                return b"", IOResult(exit_code=1)
            if name != "grep" or text_search_results(lines):
                return format_records(lines), IOResult()

    resolved = (
        await io.resolve_glob(accessor, paths, index=opts.index)
        if paths
        else []
    )
    stream = meta is None or meta.stream
    return await generic(
        resolved,
        texts,
        opts,
        readdir=bound_op(io.readdir, accessor, opts.index),
        stat=bound_op(io.stat, accessor, opts.index),
        read_bytes=bound_op(io.read_bytes, accessor, opts.index),
        read_stream=native_or_bytes(
            bound_op(io.read_stream, accessor, opts.index),
            bound_op(io.read_bytes, accessor, opts.index),
        )
        if stream
        else None,
        stdin=opts.stdin,
    )


async def _all_directories(
    io: CommandIO,
    accessor: Accessor,
    index: IndexCacheStore,
    paths: list[PathSpec],
) -> bool:
    """Whether every scope operand stats as a directory.

    File operands keep the exact single-file output shape (no walk-style
    labels), and missing operands must surface the walk's error message,
    so both fall back to the generic scan.
    """
    for path in paths:
        try:
            info = await io.stat(accessor, path, index)
        except (OSError, ValueError):
            return False
        if info.type != FileType.DIRECTORY:
            return False
    return True


async def narrow_scope(
    io: CommandIO,
    accessor: Accessor,
    index: IndexCacheStore,
    paths: list[PathSpec],
    pattern: str | None,
    *,
    fixed_string: bool,
    recursive: bool,
    whole_word: bool,
    exact_file_set: bool,
) -> tuple[list[PathSpec], bool]:
    """Resolve grep/rg scope paths, narrowing through the content index.

    Push-down needs every gate to hold: the mount opted in, the scan is
    recursive, a whole-word literal can be pushed down (which is what
    makes a word-based search complete), the output mode tolerates a
    narrowed superset (``exact_file_set`` covers flags such as -v that
    must see every file), and every scope operand is a directory. There
    is no scope-size gate: one search call plus targeted reads beats a
    full walk at every size. Binary-extension candidates are dropped,
    since the walk they replace skips them.

    Args:
        io (CommandIO): the backend table; its ``content_search`` is set.
        accessor (Accessor): backend handle.
        index (IndexCacheStore): index for the stat and glob fallback.
        paths (list[PathSpec]): scope paths, possibly mount-prefixed.
        pattern (str | None): the search pattern, or None for -f runs.
        fixed_string (bool): -F is set.
        recursive (bool): the scan walks directories.
        whole_word (bool): -w is set; required for push-down.
        exact_file_set (bool): the output must see every file in scope.

    Returns:
        tuple[list[PathSpec], bool]: the resolved paths and whether the
            index narrowed them. A narrowed set may be empty (every
            candidate was binary), which is not a stdin run.
    """
    search = io.content_search
    query = whole_word_literal(pattern, fixed_string, whole_word)
    if (
        search is not None
        and query is not None
        and recursive
        and not exact_file_set
        and search.enabled(accessor)
        and await _all_directories(io, accessor, index, paths)
    ):
        narrowed = await search.narrow_paths(accessor, query, paths)
        if narrowed:
            return text_candidates(narrowed), True
    return await io.resolve_glob(accessor, paths, index), False
