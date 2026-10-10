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
import logging
from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.grep import grep_generic
from mirage.commands.builtin.generic.grep import (
    parse_flags as parse_grep_flags,
)
from mirage.commands.builtin.generic.rg import (
    folds_case,
    rg_generic,
    rg_matcher,
    rg_syntax,
)
from mirage.commands.builtin.generic.rg import parse_flags as parse_rg_flags
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.grep_pattern import (
    PATTERN_KEYS,
    compile_pattern,
    matcher_syntax,
    pattern_arg,
)
from mirage.commands.builtin.grep_pushdown import (
    grep_search_meta,
    literal_pushdown_operand,
    pushdown_operand,
    search_terms,
    text_search_results,
)
from mirage.commands.builtin.types import SearchTerms
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.config import CommandIO, CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.types import FileTooLargeError
from mirage.io.stream import close_quietly, ensure_stream
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.shell.bytes import byte_view, utf8_locale
from mirage.types import FileType, JsonValue, PathSpec
from mirage.utils.filetype import BINARY_EXTENSIONS, get_extension
from mirage.utils.path import glob_prefix_match
from mirage.vfs.types import ScanReason, SearchQuery
from mirage.view.namespace_view import paths_scoped

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


def grep_terms(
    fl: FlagView, texts: list[str], utf8: bool
) -> SearchTerms | ScanReason:
    """What a grep line asks the mount's search, or why it cannot ask.

    Args:
        fl (FlagView): the line's grep flags.
        texts (list[str]): pattern arguments.
        utf8 (bool): grep runs under a UTF-8 locale.

    Raises:
        UsageError: a flag or pattern grep refuses.
    """
    f = parse_grep_flags(fl, False)
    pattern = pattern_arg(texts, fl, PATTERN_KEYS["grep"])
    if f.invert:
        return ScanReason.EVERY_LINE
    if pattern is None or fl.raw("file"):
        return ScanReason.NO_TEXT
    matcher = compile_pattern(
        byte_view(pattern, utf8),
        f.ignore_case,
        f.fixed_string,
        f.whole_word,
        f.syntax,
        utf8,
        f.line_regexp,
    )
    found = search_terms(
        pattern,
        matcher,
        f.fixed_string,
        f.whole_word,
        f.line_regexp,
        f.ignore_case,
    )
    if found is None:
        return ScanReason.NO_TEXT
    return SearchTerms(
        texts=found[0],
        whole_word=found[1],
        ignore_case=f.ignore_case,
        line_output=not (
            f.line_numbers
            or f.byte_offsets
            or f.after_context
            or f.before_context
        ),
        reads_binary=f.filters.text,
    )


def rg_terms(
    fl: FlagView, texts: list[str]
) -> SearchTerms | ScanReason | None:
    """What an rg line asks the mount's search, or why it cannot ask.

    None when the line reads no file content (--files, --type-list).

    Args:
        fl (FlagView): the line's rg flags.
        texts (list[str]): pattern arguments.

    Raises:
        UsageError: a flag or pattern rg refuses.
    """
    f = parse_rg_flags(fl)
    if f.list_files or f.type_list:
        return None
    pattern = pattern_arg(texts, fl, PATTERN_KEYS["rg"])
    if f.invert or f.passthru:
        return ScanReason.EVERY_LINE
    if not f.quiet and (
        f.files_without_match
        or (f.include_zero and (f.count_only or f.count_matches))
    ):
        return ScanReason.EVERY_FILE
    if f.follow:
        return ScanReason.LINKS
    if pattern is None or fl.raw("file"):
        return ScanReason.NO_TEXT
    ignore_case = folds_case(pattern, f.fixed_string, f)
    found = search_terms(
        pattern,
        rg_matcher(pattern, False, f),
        f.fixed_string,
        f.whole_word,
        f.line_regexp,
        ignore_case,
    )
    if found is None:
        return ScanReason.NO_TEXT
    return SearchTerms(
        texts=found[0],
        whole_word=found[1],
        ignore_case=ignore_case,
        line_output=not (
            f.line_numbers
            or f.byte_offsets
            or f.column
            or f.vimgrep
            or f.context_after
            or f.context_before
            or f.stop_on_nonmatch
            or f.null_data
        ),
        reads_binary=f.binary,
    )


def candidate_reads(
    read_bytes: Callable[[PathSpec], Awaitable[bytes]],
    read_stream: Callable[[PathSpec], AsyncIterator[bytes]] | None,
    narrowed: Callable[[PathSpec], Awaitable[ByteSource | None]],
) -> tuple[
    Callable[[PathSpec], Awaitable[bytes]],
    Callable[[PathSpec], AsyncIterator[bytes]] | None,
]:
    """Reads that search what ``narrowed`` answers for a file.

    The walk still lists, filters, orders and labels every file; a file
    ``narrowed`` answers empty prints exactly what one with no match
    would (-c counts 0, -L lists it), one it answers with lines is
    searched over them, and None reads the file.

    Args:
        read_bytes (Callable[[PathSpec], Awaitable[bytes]]): the bound
            whole-read op.
        read_stream (Callable[[PathSpec], AsyncIterator[bytes]] | None):
            the bound stream op, or None when the backend reads whole.
        narrowed (Callable[[PathSpec], Awaitable[ByteSource | None]]):
            what to search in place of a file, or None for the file
            itself.
    """

    async def read(path: PathSpec) -> bytes:
        data = await narrowed(path)
        return (
            await read_bytes(path) if data is None else await materialize(data)
        )

    if read_stream is None:
        return read, None
    source = read_stream

    async def stream(path: PathSpec) -> AsyncIterator[bytes]:
        data = await narrowed(path)
        chunks = source(path) if data is None else ensure_stream(data)
        try:
            async for chunk in chunks:
                if chunk:
                    yield chunk
        finally:
            await close_quietly(chunks)

    return read, stream


async def _holds_line(found: ByteSource) -> bool:
    """Whether a ``lines_containing`` answer holds a line.

    A stream is pulled to its first non-empty chunk and closed.

    Args:
        found (ByteSource): the answer.
    """
    if isinstance(found, bytes):
        return bool(found)
    try:
        async for chunk in found:
            if chunk:
                return True
        return False
    finally:
        await close_quietly(found)


async def _directories(
    io: CommandIO,
    accessor: Accessor,
    index: IndexCacheStore,
    paths: list[PathSpec],
) -> list[PathSpec]:
    """The operands that stat as directories, the scopes a walk covers.

    Args:
        io (CommandIO): the backend table.
        accessor (Accessor): backend handle.
        index (IndexCacheStore): the mount's index.
        paths (list[PathSpec]): resolved operands.
    """
    found: list[PathSpec] = []
    for path in paths:
        try:
            info = await io.stat(accessor, path, index)
        except (OSError, ValueError) as exc:
            logger.debug("search scope %s: %s", path.virtual, exc)
            continue
        if info.type == FileType.DIRECTORY:
            found.append(path)
    return found


async def search_reads(
    io: CommandIO,
    name: str,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[
    Callable[[PathSpec], Awaitable[bytes]],
    Callable[[PathSpec], AsyncIterator[bytes]] | None,
]:
    """grep's or rg's reads, narrowed by the mount's search where it can.

    ``files_containing`` rules out walked files no match can be in, of
    those the mount's ``searchable`` names, and
    ``lines_containing`` hands a file's matching lines in its place when
    the output shows nothing else, or tells whether it is worth reading.
    An operand named on the line is never ruled out by a search asked
    about directories. Neither is asked when a hide, a path rule or a
    pre_vfs policy judges a path, since a search sees the raw tree. When
    neither can stand in for a walk, ``before_full_scan`` may refuse it.

    Args:
        io (CommandIO): the backend table.
        name (str): grep or rg.
        accessor (Accessor): backend handle.
        paths (list[PathSpec]): resolved operands.
        texts (list[str]): pattern arguments.
        opts (CommandOpts): parsed invocation context.
    """
    index = opts.index
    read_bytes = bound_op(io.read_bytes, accessor, index)
    read_stream = bound_op(io.read_stream, accessor, index)
    files, lines = io.files_containing, io.lines_containing
    if paths_scoped(opts.ns, paths, opts.mount_prefix):
        files = lines = None
    if not paths or (
        files is None and lines is None and io.before_full_scan is None
    ):
        return read_bytes, read_stream
    fl = FlagView(opts.flags, spec=SPECS[name])
    try:
        terms = (
            rg_terms(fl, texts)
            if name == "rg"
            else grep_terms(fl, texts, utf8_locale(opts.env))
        )
    except UsageError as exc:
        logger.debug("%s search left to the scan: %s", name, exc)
        return read_bytes, read_stream
    if terms is None:
        return read_bytes, read_stream
    walked = name == "rg" or fl.as_bool("r") or fl.as_bool("R")
    dirs = await _directories(io, accessor, index, paths) if walked else []
    if isinstance(terms, ScanReason):
        await _full_scan(io, name, accessor, dirs, terms, index)
        return read_bytes, read_stream
    hits: set[str] | None = None
    if files is not None and dirs:
        answers = await asyncio.gather(
            *(
                files(
                    accessor,
                    text,
                    dirs,
                    whole_word=terms.whole_word,
                    ignore_case=terms.ignore_case,
                    index=index,
                )
                for text in terms.texts
            )
        )
        if all(answer is not None for answer in answers):
            hits = {
                hit.vfs_path.lower()
                for answer in answers
                if answer is not None
                for hit in answer
            }
    if hits is None and lines is None:
        await _full_scan(
            io,
            name,
            accessor,
            dirs,
            ScanReason.NO_SEARCH if files is None else ScanReason.UNANSWERED,
            index,
        )
        return read_bytes, read_stream
    named = {p.virtual for p in paths} - {p.virtual for p in dirs}
    scan_asked = False
    refusal: Exception | None = None

    async def read_unanswered() -> None:
        nonlocal scan_asked, refusal
        if refusal is not None:
            raise refusal
        if hits is None and not scan_asked:
            scan_asked = True
            try:
                await _full_scan(
                    io, name, accessor, dirs, ScanReason.UNANSWERED, index
                )
            except Exception as exc:
                refusal = exc
                raise

    async def narrowed(path: PathSpec) -> ByteSource | None:
        if (
            hits is not None
            and path.virtual not in named
            and not (
                terms.reads_binary
                and get_extension(path.virtual) in BINARY_EXTENSIONS
            )
            and path.vfs_path.lower() not in hits
            and (
                io.searchable is None
                or any(
                    glob_prefix_match(path.vfs_path, g) for g in io.searchable
                )
            )
        ):
            return b""
        if lines is None:
            return None
        if terms.line_output and len(terms.texts) == 1:
            found = await lines(
                accessor,
                path,
                terms.texts[0],
                ignore_case=terms.ignore_case,
                index=index,
            )
            if found is None:
                await read_unanswered()
            return found
        for text in terms.texts:
            found = await lines(
                accessor,
                path,
                text,
                ignore_case=terms.ignore_case,
                index=index,
            )
            if found is None:
                await read_unanswered()
                return None
            if await _holds_line(found):
                return None
        return b""

    return candidate_reads(read_bytes, read_stream, narrowed)


async def _full_scan(
    io: CommandIO,
    name: str,
    accessor: Accessor,
    dirs: list[PathSpec],
    reason: ScanReason,
    index: IndexCacheStore,
) -> None:
    """Let the mount refuse a walk that will read every file.

    Args:
        io (CommandIO): the backend table.
        name (str): grep or rg.
        accessor (Accessor): backend handle.
        dirs (list[PathSpec]): the directories about to be walked.
        reason (ScanReason): why the search cannot stand in.
        index (IndexCacheStore): the mount's index.
    """
    if dirs and io.before_full_scan is not None:
        await io.before_full_scan(accessor, name, dirs, reason, index)


async def run_search(
    io: CommandIO,
    name: str,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    """Run the adapter's native search, or scan for an unsupported request.

    The scan reads through ``search_reads``, so ``files_containing``,
    ``lines_containing`` and ``before_full_scan`` still apply.

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
    read_bytes, read_stream = await search_reads(
        io, name, accessor, resolved, texts, opts
    )
    stream = meta is None or meta.stream
    return await generic(
        resolved,
        texts,
        opts,
        readdir=bound_op(io.readdir, accessor, opts.index),
        stat=bound_op(io.stat, accessor, opts.index),
        read_bytes=read_bytes,
        read_stream=native_or_bytes(read_stream, read_bytes)
        if stream and read_stream is not None
        else None,
        stdin=opts.stdin,
    )
