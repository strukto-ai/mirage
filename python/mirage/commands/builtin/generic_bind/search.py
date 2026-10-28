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

from mirage.commands.builtin.generic.grep import (
    directories_action,
)
from mirage.commands.builtin.generic.grep import (
    parse_flags as parse_grep_flags,
)
from mirage.commands.builtin.generic.rg import encoding_flag
from mirage.commands.builtin.generic.rg import parse_flags as parse_rg_flags
from mirage.commands.builtin.generic_bind.files import CommandFiles
from mirage.commands.builtin.grep_pattern import (
    compile_pattern,
    pattern_arg,
)
from mirage.commands.builtin.grep_pushdown import (
    search_terms,
)
from mirage.commands.builtin.rg_search import folds_case
from mirage.commands.builtin.rg_stream import compiled_terms, open_rg
from mirage.commands.builtin.types import SearchTerms
from mirage.commands.builtin.utils.links import (
    links_of,
    mount_root,
    mounts_of,
)
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.types import WalkLimitError
from mirage.io.stream import close_quietly, ensure_stream
from mirage.io.types import ByteSource
from mirage.observe.context import revision_for
from mirage.shell.bytes import byte_view, utf8_locale
from mirage.types import FileType, PathSpec, ReadStreamFn
from mirage.utils.encoding import bom_of
from mirage.utils.filetype import BINARY_EXTENSIONS, get_extension
from mirage.utils.key_prefix import mount_key
from mirage.utils.path import CycleError, glob_prefix_match
from mirage.view.types import LinkView, MountView

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
        matcher.needles,
        matcher.unicode_folds,
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
    compiled = compiled_terms(open_rg(pattern, False, f))
    if not compiled.pcre:
        terms = compiled.terms
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
    pcre = compiled.terms
    found = search_terms(
        pattern,
        None if pcre is None else tuple(t.encode() for t in pcre.texts),
        ignore_case and f.unicode,
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
    stream: ReadStreamFn,
    narrowed: Callable[[PathSpec], Awaitable[ByteSource | None]],
) -> ReadStreamFn:
    """A read that searches what ``narrowed`` answers for a file.

    The walk still lists, filters, orders and labels every file; a file
    ``narrowed`` answers empty prints exactly what one with no match
    would (-c counts 0, -L lists it), one it answers with lines is
    searched over them, and None reads the file.

    Args:
        stream (ReadStreamFn): the bound read op.
        narrowed (Callable[[PathSpec], Awaitable[ByteSource | None]]):
            what to search in place of a file, or None for the file
            itself.
    """

    async def read(path: PathSpec) -> AsyncIterator[bytes]:
        data = await narrowed(path)
        chunks = stream(path) if data is None else ensure_stream(data)
        try:
            async for chunk in chunks:
                if chunk:
                    yield chunk
        finally:
            await close_quietly(chunks)

    return read


def capped_reads(
    stream: ReadStreamFn,
    operands: list[PathSpec],
    mounts: MountView | None,
) -> tuple[ReadStreamFn, Callable[[PathSpec], None]]:
    """A read that stops each walk at its mount's ``walk_limit``.

    A file counts once against the deepest walked operand above it, so a
    file named as an operand counts nothing; the one past the limit
    raises WalkLimitError in its place, and grep or rg stops walking the
    directory. The charge is returned too, for a file whose matching
    lines the mount's search hands over in place of a read; a file the
    search rules out is never read, so it costs nothing.

    Args:
        stream (ReadStreamFn): the bound read op.
        operands (list[PathSpec]): the operands walked.
        mounts (MountView | None): the mount boundaries, which name each
            operand's limit.
    """
    limits = {
        d.virtual: mounts.walk_limit(d.virtual)
        for d in operands
        if mounts is not None and mounts.walk_limit is not None
    }
    capped = sorted(
        (d for d in operands if limits.get(d.virtual, -1) >= 0),
        key=lambda d: len(d.virtual.rstrip("/")),
        reverse=True,
    )
    named = {d.virtual for d in operands}
    taken: dict[str, int] = {}
    charged: set[str] = set()

    def charge(path: PathSpec) -> None:
        if path.virtual in named or path.virtual in charged:
            return
        for d in capped:
            if path.virtual.startswith(d.virtual.rstrip("/") + "/"):
                count = taken.get(d.virtual, 0)
                if count >= limits[d.virtual]:
                    raise WalkLimitError(d, limits[d.virtual])
                taken[d.virtual] = count + 1
                charged.add(path.virtual)
                return

    if not capped:
        return stream, charge

    async def read(path: PathSpec) -> AsyncIterator[bytes]:
        charge(path)
        chunks = stream(path)
        try:
            async for chunk in chunks:
                yield chunk
        finally:
            await close_quietly(chunks)

    return read, charge


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
) -> ReadStreamFn:
    """grep's or rg's read, narrowed by the mount's search where it can.

    ``files_containing`` rules out walked files no match can be in, of
    those the mount's ``searchable`` names, and
    ``lines_containing`` hands a file's matching lines in its place when
    the output shows nothing else, or tells whether it is worth reading.
    An operand named on the line is never ruled out by a search asked
    about directories, nor is a path pinned to a revision, since a
    search sees the current content, nor a file the read cache holds
    (``is_warm``), which a read serves as it was cached, nor a path a
    link leads elsewhere, which the mount's search never sees. Both are
    asked through the dispatcher, which drops what the session hides
    from a ``files_containing`` answer, judges ``lines_containing`` as a
    read of its file, judges each file a search rules out as the read it
    stands in for (the ``is_warm`` call), so a file a path rule refuses
    reports ``Permission denied``, and answers None where a coded pre_vfs
    policy reaches below a directory, so every file is read and judged.
    Each walk stops at its mount's ``walk_limit`` (``capped_reads``).

    Args:
        files (CommandFiles): the command's files.
        name (str): grep or rg.
        paths (list[PathSpec]): resolved operands.
        texts (list[str]): pattern arguments.
        ctx (Context): parsed invocation context.
    """
    fl = FlagView(ctx.flags, spec=SPECS[name])
    if not paths or (
        name == "rg" and (fl.as_bool("files") or fl.as_bool("type_list"))
    ):
        return files.read
    walked = name == "rg" or directories_action(fl) == "recurse"
    mounts = mounts_of(ctx)
    read, charge = capped_reads(files.read, paths if walked else [], mounts)
    containing = (
        files.files_containing if files.answers("files_containing") else None
    )
    lines = (
        files.lines_containing if files.answers("lines_containing") else None
    )
    if containing is None and lines is None:
        return read
    searchable = (
        mounts.searchable(paths[0].virtual)
        if mounts is not None and mounts.searchable is not None
        else None
    )
    links = links_of(ctx)
    home = mount_root(ctx)
    try:
        terms = (
            rg_terms(fl, texts)
            if name == "rg"
            else grep_terms(fl, texts, utf8_locale(ctx.env))
        )
    except UsageError as exc:
        logger.debug("%s search left to the scan: %s", name, exc)
        return read
    dirs = await _directories(files, paths) if walked else []
    if terms is None:
        return read
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
        return read
    named = {p.virtual for p in paths} - {p.virtual for p in dirs}

    async def narrowed(path: PathSpec) -> ByteSource | None:
        # A hit and a searchable glob are keyed below the mount, as its
        # backend answers them.
        key = mount_key(path.virtual, home)
        if _linked(links, path.virtual):
            return None
        ruled_out = (
            hits is not None
            and path.virtual not in named
            and revision_for(path.virtual) is None
            and not (
                terms.reads_binary
                and get_extension(path.virtual) in BINARY_EXTENSIONS
            )
            and key.lower() not in hits
            and (
                searchable is None
                or any(glob_prefix_match(key, g) for g in searchable)
            )
        )
        if ruled_out:
            return None if await files.is_warm(path) else b""
        if lines is None or await files.is_warm(path):
            return None
        charge(path)
        if terms.line_output and len(terms.texts) == 1:
            found: ByteSource | None = await lines(
                path, terms.texts[0], ignore_case=terms.ignore_case
            )
            if found is not None and drops_mark:
                found = await _unmarked(found)
            return found
        for text in terms.texts:
            found = await lines(path, text, ignore_case=terms.ignore_case)
            if found is None:
                return None
            if await _holds_line(found):
                return None
        return b""

    return candidate_reads(read, narrowed)
