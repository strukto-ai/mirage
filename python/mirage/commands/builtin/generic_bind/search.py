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

from mirage.cache.context import active_cache_manager
from mirage.commands.builtin.generic.grep import (
    directories_action,
)
from mirage.commands.builtin.generic.grep import (
    parse_flags as parse_grep_flags,
)
from mirage.commands.builtin.generic.rg import (
    encoding_flag,
    folds_case,
    rg_matcher,
)
from mirage.commands.builtin.generic.rg import parse_flags as parse_rg_flags
from mirage.commands.builtin.generic_bind.files import CommandFiles
from mirage.commands.builtin.grep_pattern import (
    compile_pattern,
    pattern_arg,
)
from mirage.commands.builtin.grep_pushdown import (
    search_terms,
)
from mirage.commands.builtin.rg_stream import open_rg, required_terms
from mirage.commands.builtin.types import SearchTerms
from mirage.commands.builtin.utils.links import (
    dispatch_of,
    links_of,
    mounts_of,
)
from mirage.commands.builtin.utils.tree import before_full_scan
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.stream import close_quietly, ensure_stream
from mirage.io.types import ByteSource, materialize
from mirage.observe.context import revision_for
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import byte_view, utf8_locale
from mirage.types import FileType, PathSpec
from mirage.utils.encoding import bom_of
from mirage.utils.filetype import BINARY_EXTENSIONS, get_extension
from mirage.utils.path import CycleError, glob_prefix_match
from mirage.view.types import LinkView

logger = logging.getLogger(__name__)


def grep_terms(
    fl: FlagView, texts: list[str], utf8: bool
) -> SearchTerms | None:
    """What a grep line asks the mount's search; None when it must read
    every file: -v, -f, or no plain text of three characters every match
    holds (under -i, a word with a non-ASCII letter, or with i, k or s
    when case folds by Unicode, counts as none).

    Args:
        fl (FlagView): the line's grep flags.
        texts (list[str]): pattern arguments.
        utf8 (bool): grep runs under a UTF-8 locale.

    Raises:
        UsageError: a flag or pattern grep refuses.
    """
    f = parse_grep_flags(fl, False)
    pattern = pattern_arg(texts, fl)
    if f.invert:
        return None
    if pattern is None or fl.raw("file"):
        return None
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
        return None
    return SearchTerms(
        texts=found[0],
        whole_word=found[1],
        ignore_case=f.ignore_case,
        line_output=not (
            f.line_numbers
            or f.byte_offsets
            or f.after_context is not None
            or f.before_context is not None
            or f.null_data
        ),
        reads_binary=f.filters.text,
    )


def rg_terms(fl: FlagView, texts: list[str]) -> SearchTerms | None:
    """What an rg line asks the mount's search; None when it must read
    every file: -v or --passthru, a listing of files that do not match
    (--files-without-match, -c or --count-matches with --include-zero,
    without -q; --stats, --json), -L, -z, --pre, -E naming an encoding,
    -f, or no plain text every match holds.

    Args:
        fl (FlagView): the line's rg flags.
        texts (list[str]): pattern arguments.

    Raises:
        UsageError: a flag or pattern rg refuses.
    """
    f = parse_rg_flags(fl)
    pattern = pattern_arg(texts, fl)
    if f.invert or f.passthru:
        return None
    if not f.quiet and (
        f.files_without_match
        or (f.include_zero and (f.count_only or f.count_matches))
    ):
        return None
    if f.stats or f.json:
        return None
    if f.follow:
        return None
    if f.search_zip or f.pre is not None or f.encoding not in ("auto", "none"):
        return None
    if pattern is None or fl.raw("file"):
        return None
    if f.engine == "default":
        terms = required_terms(open_rg(pattern, False, f))
        if terms is None or any("\n" in term for term in terms.texts):
            return None
        return SearchTerms(
            texts=tuple(terms.texts),
            whole_word=terms.whole_word,
            ignore_case=terms.ignore_case,
            line_output=not (
                f.line_numbers
                or f.byte_offsets
                or f.column
                or f.vimgrep
                or f.context_after
                or f.context_before
                or f.stop_on_nonmatch
                or f.null_data
                or f.multiline
            ),
            reads_binary=f.text or f.null_data or f.binary,
        )
    ignore_case = folds_case(pattern, f.fixed_string, f)
    found = search_terms(
        pattern,
        rg_matcher(pattern, False, f),
        f.fixed_string,
        f.whole_word,
        f.line_regexp,
        ignore_case,
    )
    # -U matches across lines, so a text with a line break in it is no
    # line's to find.
    if found is None or (
        f.multiline and any("\n" in text for text in found[0])
    ):
        return None
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
            or f.multiline
        ),
        reads_binary=f.binary,
    )


def _linked(links: LinkView | None, virtual: str) -> bool:
    """Whether a link leads ``virtual`` elsewhere, at its name or above it.

    A mount's search sees only what its backend holds, never a link, so it
    can judge no such path.

    Args:
        links (LinkView | None): the namespace's symlink facts.
        virtual (str): the walked path.
    """
    if links is None:
        return False
    try:
        return links.resolve(virtual) != virtual
    except CycleError as exc:
        logger.debug("%s: a link loop stands in it: %s", virtual, exc)
        return True


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


async def _unmarked(found: ByteSource) -> ByteSource | None:
    """rg's ``lines_containing`` answer as it stands, or None, so the file
    is read, when it starts with a byte-order mark: rg drops a mark only
    where the file starts, which an answer cannot say it does. Under
    ``-E none`` rg keeps the mark, so its answer is not asked here.

    Args:
        found (ByteSource): the answer.
    """
    if isinstance(found, bytes):
        return None if bom_of(found) is not None else found
    head = b""
    async for chunk in found:
        head += chunk
        if len(head) >= 3:
            break
    if bom_of(head) is not None:
        await close_quietly(found)
        return None
    return _replayed(head, found)


async def _replayed(
    head: bytes, rest: AsyncIterator[bytes]
) -> AsyncIterator[bytes]:
    try:
        if head:
            yield head
        async for chunk in rest:
            yield chunk
    finally:
        await close_quietly(rest)


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
    files: CommandFiles, paths: list[PathSpec]
) -> list[PathSpec]:
    """The operands that stat as directories, the scopes a walk covers.

    Args:
        files (CommandFiles): the command's files.
        paths (list[PathSpec]): resolved operands.
    """
    found: list[PathSpec] = []
    for path in paths:
        try:
            info = await files.stat(path)
        except (OSError, ValueError) as exc:
            logger.debug("search scope %s: %s", path.virtual, exc)
            continue
        if info.type == FileType.DIRECTORY:
            found.append(path)
    return found


async def search_reads(
    files: CommandFiles,
    name: str,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
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
    about directories, nor is a path pinned to a revision, since a
    search sees the current content, nor a file the read cache holds,
    which a read serves as it was cached, nor a path a link leads
    elsewhere, which the mount's search never sees. Both are asked
    through the dispatcher, which drops what the session hides from a
    ``files_containing`` answer, judges ``lines_containing`` as a read of
    its file, and answers None where a path rule or a pre_vfs policy
    reaches below a directory, so every file is read and judged. When
    neither can stand in for a walk, the mount's ``before_full_scan`` may
    refuse it.

    Args:
        files (CommandFiles): the command's files.
        name (str): grep or rg.
        paths (list[PathSpec]): resolved operands.
        texts (list[str]): pattern arguments.
        ctx (Context): parsed invocation context.
    """
    read_bytes = files.read_bytes
    read_stream = files.read_stream
    containing = (
        files.files_containing if files.answers("files_containing") else None
    )
    lines = (
        files.lines_containing if files.answers("lines_containing") else None
    )
    mounts = mounts_of(ctx)
    searchable = (
        mounts.searchable((paths[0] if paths else ctx.cwd).virtual)
        if mounts is not None and mounts.searchable is not None
        else None
    )
    links = links_of(ctx)
    fl = FlagView(ctx.flags, spec=SPECS[name])
    if not paths or (
        name == "rg" and (fl.as_bool("files") or fl.as_bool("type_list"))
    ):
        return read_bytes, read_stream
    walked = name == "rg" or directories_action(fl) == "recurse"
    if containing is None and lines is None:
        if walked:
            await _full_scan(dispatch_of(ctx), paths, name)
        return read_bytes, read_stream
    try:
        terms = (
            rg_terms(fl, texts)
            if name == "rg"
            else grep_terms(fl, texts, utf8_locale(ctx.env))
        )
    except UsageError as exc:
        logger.debug("%s search left to the scan: %s", name, exc)
        return read_bytes, read_stream
    dirs = await _directories(files, paths) if walked else []
    if terms is None:
        await _full_scan(dispatch_of(ctx), dirs, name)
        return read_bytes, read_stream
    drops_mark = name == "rg" and encoding_flag(fl) != "none"
    hits: set[str] | None = None
    if containing is not None and dirs:
        answers = await asyncio.gather(
            *(
                containing(
                    scope,
                    text,
                    whole_word=terms.whole_word,
                    ignore_case=terms.ignore_case,
                )
                for scope in dirs
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
        await _full_scan(dispatch_of(ctx), dirs, name)
        return read_bytes, read_stream
    if hits is not None and terms.reads_binary:
        await _full_scan(dispatch_of(ctx), dirs, name)
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
                await _full_scan(dispatch_of(ctx), dirs, name)
            except Exception as exc:
                refusal = exc
                raise

    async def narrowed(path: PathSpec) -> ByteSource | None:
        manager = active_cache_manager()
        if manager is not None and await manager.is_cached(path):
            return None
        if _linked(links, path.virtual):
            return None
        if (
            hits is not None
            and path.virtual not in named
            and revision_for(path.virtual) is None
            and not (
                terms.reads_binary
                and get_extension(path.virtual) in BINARY_EXTENSIONS
            )
            and path.vfs_path.lower() not in hits
            and (
                searchable is None
                or any(glob_prefix_match(path.vfs_path, g) for g in searchable)
            )
        ):
            return b""
        if lines is None:
            return None
        if terms.line_output and len(terms.texts) == 1:
            found: ByteSource | None = await lines(
                path, terms.texts[0], ignore_case=terms.ignore_case
            )
            if found is not None and drops_mark:
                found = await _unmarked(found)
            if found is None:
                await read_unanswered()
            return found
        for text in terms.texts:
            found = await lines(path, text, ignore_case=terms.ignore_case)
            if found is None:
                await read_unanswered()
                return None
            if await _holds_line(found):
                return None
        return b""

    return candidate_reads(read_bytes, read_stream, narrowed)


async def _full_scan(
    dispatch: DispatchFn | None, dirs: list[PathSpec], name: str
) -> None:
    """Let each walked directory's mount refuse a walk that reads every
    file; the dispatcher passes over a path that is not a directory.

    Args:
        dispatch (DispatchFn | None): the command's dispatcher.
        dirs (list[PathSpec]): the operands about to be walked.
        name (str): grep or rg.
    """
    for scope in dirs:
        await before_full_scan(dispatch, scope, name)
