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
import time
from collections.abc import AsyncIterator
from dataclasses import replace
from typing import cast

from mirage.commands.builtin.generic.crossmount.fanout.exit import (
    combined_exit,
)
from mirage.commands.builtin.generic.crossmount.scopes import (
    owned_scopes,
)
from mirage.commands.builtin.generic.crossmount.types import (
    CrossResult,
    OperandRun,
    OwnedScope,
    RunSingle,
)
from mirage.commands.builtin.generic.crossmount.utils import (
    merge_operand_ios,
    run_operands,
    run_separator,
)
from mirage.commands.builtin.generic.grep import (
    filename_mode,
    line_warnings,
    parse_flags,
)
from mirage.commands.builtin.generic.rg import (
    filters_files,
    haystacks,
    headed,
    ignore_rules,
    json_summary,
    label_flags,
    rg_matcher,
    runs_parallel,
    sort_haystacks,
    walk_filter,
)
from mirage.commands.builtin.generic.rg import (
    parse_flags as parse_rg_flags,
)
from mirage.commands.builtin.grep_binary import GrepFlags
from mirage.commands.builtin.grep_pattern import (
    LineMatcher,
    compile_pattern,
    pattern_arg,
)
from mirage.commands.builtin.grep_select import dir_admitted, file_admitted
from mirage.commands.builtin.rg_scan import walk_error_line
from mirage.commands.builtin.rg_search import RgFlags, Totals, split_footer
from mirage.commands.builtin.rg_stream import format_totals, open_rg
from mirage.commands.builtin.utils.links import (
    LinkResolver,
    link_view,
    mount_view,
)
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.stream import is_stdin, resolve_source
from mirage.commands.builtin.utils.tree import before_full_scan
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagBag, FlagView
from mirage.commands.spec.types import FlagValue
from mirage.errors.constants import FS_ERRORS
from mirage.errors.render import fs_error_line
from mirage.io import IOResult
from mirage.io.types import ByteSource, materialize
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import byte_view, encode_text
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.filetype import BINARY_EXTENSIONS, get_extension
from mirage.workspace.files import Files

logger = logging.getLogger(__name__)


def _admit_grep(flags: GrepFlags, path: PathSpec, info: FileStat) -> bool:
    if info.type == FileType.DIRECTORY:
        return dir_admitted(path.virtual, flags.filters)
    return (
        info.type == FileType.FILE
        and file_admitted(path.virtual, flags.filters)
        and (
            flags.filters.text
            or get_extension(path.virtual) not in BINARY_EXTENSIONS
        )
    )


async def run_search(
    name: str,
    paths: list[PathSpec],
    texts: list[str],
    flags: dict[str, FlagValue],
    dispatch: DispatchFn,
    run_single: RunSingle,
    cwd: str,
    vfs: Files | None = None,
    stdin: ByteSource | None = None,
    utf8: bool = False,
) -> CrossResult:
    """Compose the registered search handlers, preserving operand order.

    Recursive search delegates only scopes whose backend owns every entry.
    A search with global walk state (rg sorting, depth and link following)
    uses its existing metadata walker before delegating selected files.
    Content always stays with the registered handler.

    Args:
        name (str): grep or rg.
        paths (list[PathSpec]): Original operands, including repetitions.
        texts (list[str]): Prepared pattern operands.
        flags (dict[str, FlagValue]): Parsed options.
        dispatch (DispatchFn): Workspace operations.
        run_single (RunSingle): Full native command execution boundary.
        cwd (str): Working directory.
        vfs (Files | None): Namespace ownership and link facts.
        stdin (ByteSource | None): Shared standard input.
        utf8 (bool): the session runs under a UTF-8 locale.
    """
    links = link_view(vfs)
    mounts = mount_view(vfs)
    started = time.perf_counter()
    view = FlagView(flags, spec=SPECS[name])
    grep = parse_flags(view, never_match=False) if name == "grep" else None
    rg = parse_rg_flags(view) if name == "rg" else None
    # --ignore-file's rules judge every walked file, the ones a nested
    # mount turns into operands of their own runs too; each run reads
    # them again, so a file that could not be read is noted once, here.
    notes: list[str] = []
    ignores = (
        await ignore_rules(view, dispatch, notes) if rg is not None else None
    )
    nested = bool(
        mounts is not None
        and any(mounts.descendants(p.virtual) for p in paths)
    )
    # A link can change the owner without appearing in the mount table.
    linked = bool(
        links is not None and any(links.subtree(p.virtual) for p in paths)
    )
    planned = rg is not None and (
        linked
        or rg.sort is not None
        or (
            nested
            and (
                rg.max_depth is not None
                or rg.follow
                or rg.one_file_system
                or filters_files(rg)
                or not (ignores is None or ignores.empty)
            )
        )
    )
    if rg is not None and rg.type_list:
        return await run_single(name, paths[:1], texts, flags)
    matcher: LineMatcher | None = None
    if grep is not None:
        pattern = pattern_arg(texts, view)
        if pattern is not None:
            matcher = compile_pattern(
                byte_view(pattern, utf8),
                grep.ignore_case,
                grep.fixed_string,
                grep.whole_word,
                grep.syntax,
                utf8,
                grep.line_regexp,
            )
    if rg is not None and not rg.list_files:
        pattern = pattern_arg(texts, view)
        if pattern is not None:
            if rg.engine == "default":
                open_rg(pattern, False, rg)
            else:
                rg_matcher(pattern, False, rg)
    quiet = grep.quiet if grep is not None else bool(rg and rg.quiet)
    # -q stops at the first match, but --stats and --json count every file.
    stops = quiet and not (rg is not None and (rg.stats or rg.json))

    input_source = resolve_source(stdin)
    owners = [
        mounts.root_of(p.virtual) if mounts is not None else None
        for p in paths
    ]

    async def execute(
        cmd: str,
        operands: list[PathSpec],
        words: list[str],
        bag: dict[str, FlagValue],
    ) -> CrossResult:
        return await run_single(
            cmd,
            operands,
            words,
            bag,
            stdin=input_source if any(is_stdin(p) for p in operands) else None,
        )

    walk = walk_filter(rg, None, ignores) if rg is not None else None

    def admit(path: PathSpec, info: FileStat) -> bool:
        if grep is not None:
            return _admit_grep(grep, path, info)
        assert walk is not None
        name = path.virtual.rsplit("/", 1)[-1]
        if info.type == FileType.DIRECTORY:
            return walk.admits(path.virtual, name, True)
        return info.type == FileType.FILE and walk.admits_file(
            path.virtual, name, info
        )

    async def readdir(virtual: str) -> list[str]:
        data, _ = await dispatch("readdir", PathSpec.from_str_path(virtual))
        return cast(list[str], data)

    async def stat(virtual: str) -> FileStat:
        data, _ = await dispatch(
            "stat", PathSpec.from_str_path(virtual), nofollow=True
        )
        return cast(FileStat, data)

    async def scopes() -> AsyncIterator[OwnedScope]:
        if planned:
            assert rg is not None and walk is not None
            # The plan hands each file over alone, which no search
            # narrows, so every directory walked is read whole; a listing
            # reads none.
            for path in [] if rg.list_files or rg.type_list else paths:
                try:
                    info = await stat(path.virtual)
                except FS_ERRORS as exc:
                    logger.debug("rg plan %s: %s", path.virtual, exc)
                    continue
                if info.type == FileType.DIRECTORY:
                    await before_full_scan(dispatch, path, name)
            warnings: list[str] = []
            resolver = (
                LinkResolver(links, dispatch, cwd)
                if links is not None
                else None
            )
            found = haystacks(
                paths,
                readdir,
                stat,
                cwd,
                walk,
                rg,
                warnings,
                mounts if rg.one_file_system else None,
                resolver,
            )
            if rg.sort not in (None, "none") and not (
                rg.sort == "path" and not rg.sort_reverse
            ):
                listed = sort_haystacks([h async for h in found], rg)
                for message in warnings:
                    yield OwnedScope(paths[0], diagnostic=message + "\n")
                warnings.clear()
                for h in listed:
                    yield OwnedScope(
                        h.spec
                        or replace(
                            PathSpec.from_str_path(h.virtual), raw_path=h.shown
                        ),
                        h.spec is None,
                        h.stat,
                    )
                return
            async for h in found:
                for message in warnings:
                    yield OwnedScope(paths[0], diagnostic=message + "\n")
                warnings.clear()
                yield OwnedScope(
                    h.spec
                    or replace(
                        PathSpec.from_str_path(h.virtual), raw_path=h.shown
                    ),
                    h.spec is None,
                    h.stat,
                )
            for message in warnings:
                yield OwnedScope(paths[0], diagnostic=message + "\n")
            return
        for path in paths:
            if rg is not None or (grep is not None and grep.recursive):
                async for scope in owned_scopes(path, dispatch, vfs, admit):
                    yield scope
            else:
                yield OwnedScope(path)

    results: list[OperandRun] = []
    walked: set[int] = set()
    async for scope in scopes():
        if scope.error is not None or scope.diagnostic is not None:
            message = scope.diagnostic
            if message is None:
                assert scope.error is not None
                message = (
                    (
                        walk_error_line(
                            scope.path.raw_path,
                            scope.error,
                            rg.threads != 1
                            and (len(paths) > 1 or scope.walked),
                        )
                        + "\n"
                    )
                    if rg is not None
                    else fs_error_line(name, scope.path, scope.error)
                )
            results.append(
                OperandRun(
                    scope.path,
                    b"",
                    IOResult(
                        exit_code=2,
                        stderr=encode_text(message)
                        if rg is None or not rg.no_messages
                        else None,
                    ),
                )
            )
            continue
        local = FlagBag(flags) if grep is not None else label_flags(flags)
        if grep is not None and filename_mode(view) is None:
            # A directory run already labels its files. Keep its native
            # search eligibility; only split file operands need explicit H.
            owner = (
                mounts.root_of(scope.path.virtual)
                if mounts is not None
                else None
            )
            repeated = owners.count(owner) > 1
            if (
                scope.stat is None
                or scope.stat.type != FileType.DIRECTORY
                or repeated
                or (
                    scope.walked
                    and not (
                        mounts is not None
                        and mounts.is_root(scope.path.virtual)
                    )
                )
            ):
                local["with_filename"] = True
        runs = await run_operands(execute, name, [scope.path], texts, local)
        if scope.stat is not None and scope.stat.type == FileType.DIRECTORY:
            walked.add(len(results))
        results.extend(runs)
        if stops and runs[-1].io.exit_code == 0:
            break
    code = combined_exit(
        name,
        [r.io.exit_code for r in results],
        [r.io.exit_code != 0 and r.io.stderr is not None for r in results],
        quiet,
    )
    parts, footer = (
        _one_footer(results, rg, walked, started)
        if rg is not None and (rg.stats or rg.json)
        else ([r.data for r in results], b"")
    )
    body = run_separator(name, flags).join(p for p in parts if p) + footer
    # Each run says what the line says once, grep's warnings or rg's notes
    # of the ignore files it could not read; the line keeps one.
    noted = (
        line_warnings(view, matcher)
        if grep is not None
        else format_records(notes)
        if rg is not None and notes and not rg.no_messages
        else b""
    )
    if not noted:
        return body, await merge_operand_ios(results, code)
    for r in results:
        if r.io.stderr is not None:
            err = await materialize(r.io.stderr)
            r.io.stderr = err.removeprefix(noted) or None
    io = await merge_operand_ios(results, code)
    io.stderr = noted + (
        await materialize(io.stderr) if io.stderr is not None else b""
    )
    return body, io


def _one_footer(
    results: list[OperandRun], f: RgFlags, walked: set[int], started: float
) -> tuple[list[bytes], bytes]:
    """The runs' outputs with each --stats block or --json summary cut
    off, and the one footer that totals them, as a single rg prints it.

    A run that walked a directory on ripgrep's parallel searcher closed
    its last --heading group with a blank line too; that line goes with
    its footer.

    Args:
        results (list[OperandRun]): the runs, in order.
        f (RgFlags): the parsed flags.
        walked (set[int]): the runs that walked a directory.
        started (float): when the line started, for the total time.
    """
    summary = json_summary(f)
    blank = not summary and headed(f) and runs_parallel(f)
    parts = [r.data for r in results]
    totals = Totals()
    found = False
    for i, data in enumerate(parts):
        head, part = split_footer(data, summary)
        if part is None:
            continue
        found = True
        totals.merge(part)
        parts[i] = head[:-1] if blank and head and i in walked else head
    if not found:
        return parts, b""
    total = time.perf_counter() - started
    if summary:
        return parts, (
            format_totals(totals, "summary", total)
            if f.engine == "default"
            else totals.summary_record(total)
        )
    return parts, (b"\n" if blank and any(parts) else b"") + (
        format_totals(totals, "stats", total)
        if f.engine == "default"
        else totals.stats_block(total)
    )
