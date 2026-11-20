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

import dataclasses
import logging
import posixpath
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass

from mirage.commands.builtin.generic.rg import ignore_reader
from mirage.commands.builtin.generic.rg import parse_flags as rg_flags
from mirage.commands.builtin.rg_filetypes import FileTypes
from mirage.commands.builtin.rg_glob import (
    IgnoreRules,
    IgnoreSources,
    Overrides,
    compile_glob,
    ignore_lines,
)
from mirage.commands.builtin.rg_scan import (
    Haystack,
    WalkFilter,
    walk_haystacks,
)
from mirage.commands.builtin.rg_search import (
    RgFlags,
    Tally,
    smart_case_folds,
)
from mirage.commands.builtin.rg_stream import (
    RgProgram,
    open_rg,
    stream_haystack,
)
from mirage.commands.builtin.utils.links import (
    dispatch_of,
    link_resolver,
    mount_root,
    mounts_of,
)
from mirage.commands.builtin.utils.paths import vfs_readdir_path, vfs_stat_path
from mirage.commands.builtin.utils.wrap import (
    mount_parent_readdir,
    mount_parent_stat,
    to_pathspec,
)
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.constants import FS_ERRORS, WALK_ERRORS
from mirage.errors.fs import enoent
from mirage.io.stream import drain, yield_bytes
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.runtime.types import DispatchFn, ShellFn
from mirage.shell.bytes import encode_text
from mirage.shell.join import shell_join
from mirage.types import FileStat, FileType, LineFacts, PathSpec

logger = logging.getLogger(__name__)

_TYPES = {
    "f": "file",
    "file": "file",
    "d": "directory",
    "dir": "directory",
    "directory": "directory",
    "l": "symlink",
    "symlink": "symlink",
    "b": "block-device",
    "block-device": "block-device",
    "c": "char-device",
    "char-device": "char-device",
    "x": "executable",
    "executable": "executable",
    "e": "empty",
    "empty": "empty",
    "s": "socket",
    "socket": "socket",
    "p": "pipe",
    "pipe": "pipe",
}
_TYPE_NAMES = (
    "file, directory, symlink, block-device, char-device, executable, "
    "empty, socket, pipe"
)
_KINDS = {
    FileType.FILE: "file",
    FileType.DIRECTORY: "directory",
    FileType.SYMLINK: "symlink",
    FileType.BLOCK_DEVICE: "block-device",
    FileType.CHAR_DEVICE: "char-device",
    FileType.SOCKET: "socket",
    FileType.FIFO: "pipe",
}
_PLACEHOLDER = re.compile(r"\{(?:/\.|//|/|\.)?\}")
_REGEX_NOTE = (
    "\n\nNote: You can use the '--fixed-strings' option to search for a "
    "literal string instead of a regular expression. Alternatively, you "
    "can also use the '--glob' option to match on a glob pattern."
)
_HELP_HINT = "\n\nFor more information, try '--help'."


@dataclass(frozen=True, slots=True)
class Kinds:
    """What ``--type`` keeps, as fd reads its values: the entry kinds it
    lists, then ``executable`` and ``empty`` as tests every kept entry
    must also pass. ``empty`` alone lists empty files and directories.

    Args:
        kinds (frozenset[str]): the kinds listed; empty for every kind.
        executable (bool): only entries with an execute bit.
        empty (bool): only empty files and directories.
    """

    kinds: frozenset[str] = frozenset()
    executable: bool = False
    empty: bool = False


@dataclass(frozen=True, slots=True)
class FdFlags:
    """fd's options, parsed once.

    Args:
        pattern (str): the pattern, empty to match every entry.
        syntax (str): ``regex``, ``glob`` or ``fixed``.
        ignore_case (bool): the match ignores case: -i, or the default
            smart case over a pattern with no uppercase letter.
        full_path (bool): -p, match the absolute path, not the name.
        hidden (bool): -H, list hidden entries.
        sources (IgnoreSources): the ignore files the walk reads.
        ignore_files (tuple[PathSpec, ...]): --ignore-file's files.
        kinds (Kinds): --type.
        extensions (tuple[str, ...]): -e, lowercased, without a dot.
        excludes (tuple[str, ...]): -E's globs.
        max_depth (int | None): -d, the deepest entry listed.
        min_depth (int | None): --min-depth, the shallowest one.
        absolute (bool): -a.
        follow (bool): -L.
        print0 (bool): -0.
        max_results (int | None): --max-results and -1.
        quiet (bool): -q.
        exec_words (tuple[str, ...] | None): -x's command.
        batch_words (tuple[str, ...] | None): -X's command.
        strip_prefix (str): --strip-cwd-prefix: auto, always or never.
    """

    pattern: str
    syntax: str
    ignore_case: bool
    full_path: bool
    hidden: bool
    sources: IgnoreSources
    ignore_files: tuple[PathSpec, ...]
    kinds: Kinds
    extensions: tuple[str, ...]
    excludes: tuple[str, ...]
    max_depth: int | None
    min_depth: int | None
    absolute: bool
    follow: bool
    print0: bool
    max_results: int | None
    quiet: bool
    exec_words: tuple[str, ...] | None
    batch_words: tuple[str, ...] | None
    strip_prefix: str


def _clap_error(body: str) -> UsageError:
    return UsageError(f"error: {body}{_HELP_HINT}", 2)


def _count(fl: FlagView, dest: str, shown: str) -> int | None:
    value = fl.as_str(dest)
    if value is None:
        return None
    if not value.isdigit():
        reason = (
            "cannot parse integer from empty string"
            if not value
            else "invalid digit found in string"
        )
        raise _clap_error(f"invalid value '{value}' for '{shown}': {reason}")
    return int(value)


def _kinds_of(values: Sequence[str]) -> Kinds:
    if not values:
        return Kinds()
    named: set[str] = set()
    for value in values:
        kind = _TYPES.get(value)
        if kind is None:
            raise _clap_error(
                f"invalid value '{value}' for '--type <filetype>'\n"
                f"  [possible values: {_TYPE_NAMES}]"
            )
        named.add(kind)
    executable = "executable" in named
    empty = "empty" in named
    kinds = named - {"executable", "empty"}
    if executable:
        kinds.add("file")
    if empty and not kinds & {"file", "directory"}:
        kinds |= {"file", "directory"}
    return Kinds(frozenset(kinds), executable, empty)


def _last(fl: FlagView, *dests: str) -> str | None:
    typed = fl.typed_order(*dests)
    return typed[-1] if typed else None


def parse_flags(fl: FlagView, texts: Sequence[str]) -> FdFlags:
    """fd's options, the last of each overriding pair winning.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        texts (Sequence[str]): the pattern operand, when one was typed.

    Raises:
        UsageError: a value fd refuses, in clap's words.
    """
    pattern = texts[0] if texts else ""
    syntax = (
        "glob"
        if fl.as_bool("glob")
        else "fixed"
        if fl.as_bool("fixed_strings")
        else "regex"
    )
    case = _last(fl, "case_sensitive", "ignore_case")
    if case == "ignore_case":
        ignore_case = True
    elif case == "case_sensitive":
        ignore_case = False
    elif syntax == "glob":
        ignore_case = not any(ch.isupper() for ch in pattern)
    else:
        ignore_case = smart_case_folds(pattern, syntax == "fixed")
    unrestricted = fl.as_int("unrestricted") or 0
    no_ignore = fl.as_bool("no_ignore") or unrestricted > 0
    vcs = not no_ignore and not fl.as_bool("no_ignore_vcs")
    sources = IgnoreSources(
        vcs=vcs,
        exclude=vcs,
        dot=not no_ignore,
        custom=".fdignore",
        parents=not fl.as_bool("no_ignore_parent"),
        require_git=not fl.as_bool("no_require_git"),
        bom=False,
    )
    exact = _count(fl, "exact_depth", "--exact-depth <depth>")
    max_depth = _count(fl, "max_depth", "--max-depth <depth>")
    min_depth = _count(fl, "min_depth", "--min-depth <depth>")
    if exact is not None:
        max_depth = min_depth = exact
    max_results = _count(fl, "max_results", "--max-results <count>")
    if fl.as_bool("args_1"):
        max_results = 1
    if max_results == 0:
        max_results = None
    _count(fl, "threads", "--threads <num>")
    exec_words = fl.as_list("exec") if fl.raw("exec") is not None else None
    batch_words = (
        fl.as_list("exec_batch") if fl.raw("exec_batch") is not None else None
    )
    for words, shown in (
        (exec_words, "--exec <cmd>..."),
        (batch_words, "--exec-batch <cmd>..."),
    ):
        if words is not None and not words:
            raise _clap_error(
                f"a value is required for '{shown}' but none was supplied"
            )
    return FdFlags(
        pattern=pattern,
        syntax=syntax,
        ignore_case=ignore_case,
        full_path=fl.as_bool("full_path"),
        hidden=fl.as_bool("hidden") or unrestricted > 0,
        sources=sources,
        ignore_files=tuple(fl.as_paths("ignore_file")),
        kinds=_kinds_of(fl.as_list("type")),
        extensions=tuple(
            ext.removeprefix(".").lower() for ext in fl.as_list("extension")
        ),
        excludes=tuple(fl.as_list("exclude")),
        max_depth=max_depth,
        min_depth=min_depth,
        absolute=fl.as_bool("absolute_path"),
        follow=fl.as_bool("follow"),
        print0=fl.as_bool("print0"),
        max_results=max_results,
        quiet=fl.as_bool("quiet"),
        exec_words=None if exec_words is None else tuple(exec_words),
        batch_words=None if batch_words is None else tuple(batch_words),
        strip_prefix=fl.as_str("strip_cwd_prefix") or "auto",
    )


def facts(fl: FlagView, operands: Sequence[str | PathSpec]) -> LineFacts:
    """An fd line reads below every directory it names and walks into the
    mounts below them; it changes nothing itself.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        operands (Sequence[str | PathSpec]): the line's operands.
    """
    return LineFacts(walks=True, reads_subtree=True, writes=False)


class _Matcher:
    """Whether an entry's name (or, under -p, its absolute path) matches
    the pattern: a regex or -F literal runs ripgrep's engine, one record
    per name, so its syntax and case folding are the Rust regex crate's,
    as fd's are; a glob compiles to globset's form.

    Args:
        f (FdFlags): the parsed flags.
    """

    def __init__(self, f: FdFlags) -> None:
        self._f = f
        self._glob: re.Pattern[str] | None = None
        self._program: RgProgram | None = None
        self._rg: RgFlags | None = None
        if not f.pattern:
            return
        try:
            if f.syntax == "glob":
                self._glob = compile_glob(f.pattern, f.ignore_case)
                return
            self._rg = dataclasses.replace(
                rg_flags(FlagView({}, spec=SPECS["rg"])),
                ignore_case=f.ignore_case,
                smart_case=False,
                fixed_string=f.syntax == "fixed",
                null_data=True,
                quiet=True,
            )
            self._program = open_rg(f.pattern, False, self._rg)
        except UsageError as exc:
            message = _unwrapped(str(exc).removeprefix("rg: "), f.pattern)
            note = _REGEX_NOTE if f.syntax == "regex" else ""
            raise UsageError(f"[fd error]: {message}{note}", 1) from exc

    async def matches(self, subject: str) -> bool:
        """Whether one name or path matches.

        Args:
            subject (str): the name, or the absolute path under -p.
        """
        if self._glob is not None:
            return self._glob.fullmatch(subject) is not None
        if self._program is None or self._rg is None:
            return True
        tally = Tally()
        await drain(
            stream_haystack(
                yield_bytes(encode_text(subject)),
                self._program,
                self._rg,
                "",
                None,
                tally,
                False,
                False,
            )
        )
        return tally.selected


def _unwrapped(message: str, pattern: str) -> str:
    """A regex refusal with the pattern as fd shows it: ripgrep's engine
    quotes the group it wraps every pattern in, ``(?:...)``, and points
    three columns further right. A refusal that points at the wrapper
    itself (``a(b``, whose group the wrapper's ``)`` closes) keeps the
    engine's excerpt, which fd, parsing the pattern bare, words
    differently.

    Args:
        message (str): the engine's refusal.
        pattern (str): the pattern as typed.
    """
    lines = message.split("\n")
    if (
        len(lines) >= 3
        and lines[1] == f"    (?:{pattern})"
        and lines[2].startswith(" " * 7)
    ):
        lines[1] = f"    {pattern}"
        lines[2] = lines[2][:4] + lines[2][7:]
    return "\n".join(lines)


def _absolute(path: str, cwd: str) -> str:
    if path.startswith("/"):
        return path
    rest = path[2:] if path.startswith("./") else path
    return posixpath.join(cwd, rest) if rest not in ("", ".") else cwd


def _root_shown(raw: str) -> str:
    stripped = raw.rstrip("/")
    return stripped if stripped else raw[:1]


def _sort_key(path: str) -> str:
    """A path's place in fd's order, which compares paths component by
    component: NUL sorts below every character a name can hold.

    Args:
        path (str): the path as walked.
    """
    return "\0".join(part for part in path.split("/") if part not in ("", "."))


def _dirname(path: str) -> str:
    parent = posixpath.dirname(path)
    return parent if parent else "."


def _stem(name: str) -> str:
    dot = name.rfind(".")
    return name[:dot] if dot > 0 else name


def _without_extension(path: str) -> str:
    joined = posixpath.join(_dirname(path), _stem(posixpath.basename(path)))
    return joined[2:] if joined.startswith("./") else joined


def _expand(word: str, path: str) -> str:
    def one(match: re.Match[str]) -> str:
        token = match.group(0)
        if token == "{}":
            return path
        if token == "{/}":
            return posixpath.basename(path)
        if token == "{//}":
            return _dirname(path)
        if token == "{.}":
            return _without_extension(path)
        return _stem(posixpath.basename(path))

    return _PLACEHOLDER.sub(one, word)


def exec_argv(words: Sequence[str], path: str) -> list[str]:
    """-x's command for one result: each placeholder filled, or the path
    appended when the command names none.

    Args:
        words (Sequence[str]): the command as typed.
        path (str): the result as the command sees it.
    """
    if not any(_PLACEHOLDER.search(word) for word in words):
        return [*words, path]
    return [_expand(word, path) for word in words]


def batch_argv(words: Sequence[str], paths: Sequence[str]) -> list[str]:
    """-X's one command: each word holding a placeholder repeated for
    every result, or the results appended when it names none.

    Args:
        words (Sequence[str]): the command as typed.
        paths (Sequence[str]): every result as the command sees it.
    """
    if not any(_PLACEHOLDER.search(word) for word in words):
        return [*words, *paths]
    argv: list[str] = []
    for word in words:
        if _PLACEHOLDER.search(word):
            argv.extend(_expand(word, path) for path in paths)
        else:
            argv.append(word)
    return argv


@dataclass(frozen=True, slots=True)
class _Result:
    """One entry fd lists.

    Args:
        path (str): the entry as walked, from the operand as typed.
        is_dir (bool): it is a directory, which output marks with ``/``.
        implicit (bool): it lies below the implicit cwd, whose ``./`` fd
            strips unless -0, -x or -X asks for it.
    """

    path: str
    is_dir: bool
    implicit: bool


async def _is_empty(
    hit: Haystack, readdir: Callable[[str], Awaitable[list[str]]]
) -> bool:
    if hit.stat is None:
        return False
    if hit.stat.type == FileType.FILE:
        return hit.stat.size == 0
    if hit.stat.type != FileType.DIRECTORY:
        return False
    try:
        if hit.resolver is not None:
            return not await hit.resolver.readdir(hit.virtual)
        return not await readdir(hit.virtual)
    except WALK_ERRORS as exc:
        logger.debug("fd: cannot list %s: %s", hit.virtual, exc)
        return False


async def _kept(
    hit: Haystack,
    f: FdFlags,
    matcher: _Matcher,
    cwd: str,
    readdir: Callable[[str], Awaitable[list[str]]],
) -> bool:
    stat = hit.stat
    if stat is None:
        return False
    if f.min_depth is not None and hit.depth < f.min_depth:
        return False
    kinds = f.kinds
    if kinds.kinds and _KINDS.get(stat.type) not in kinds.kinds:
        return False
    if kinds.executable and not (stat.mode or 0) & 0o111:
        return False
    name = posixpath.basename(hit.shown)
    if f.extensions and not any(
        name.lower().endswith("." + ext) for ext in f.extensions
    ):
        return False
    subject = _absolute(hit.shown, cwd) if f.full_path else name
    if not await matcher.matches(subject):
        return False
    return not kinds.empty or await _is_empty(hit, readdir)


async def _ignore_rules_of(
    paths: Sequence[PathSpec], dispatch: DispatchFn | None
) -> IgnoreRules:
    lines: list[str] = []
    for path in paths:
        if dispatch is None:
            continue
        try:
            data, _ = await dispatch("read", path)
            lines.extend(ignore_lines(await materialize(data), False))
        except FS_ERRORS as exc:
            logger.debug("fd: cannot read %s: %s", path.raw_path, exc)
    return IgnoreRules(lines)


async def _run(
    shell: ShellFn | None, argv: Sequence[str], out: bytearray, err: bytearray
) -> bool:
    if shell is None:
        err.extend(encode_text(f"[fd error]: Command not found: {argv[0]}\n"))
        return False
    io = await shell(shell_join(list(argv)), b"")
    if io.stdout is not None:
        out.extend(await materialize(io.stdout))
    if io.stderr is not None:
        err.extend(await materialize(io.stderr))
    return io.exit_code == 0


async def fd_generic(
    paths: list[PathSpec],
    texts: Sequence[str],
    ctx: Context,
    *,
    readdir: Callable[..., Awaitable[list[str]]],
    stat: Callable[..., Awaitable[FileStat]],
) -> tuple[ByteSource | None, IOResult]:
    """List the entries below each search path whose name matches.

    fd walks with ripgrep's ignore rules (``.gitignore`` inside a
    repository, ``.ignore``, ``.fdignore``), skips hidden entries
    unless -H, and never lists a search path itself. Its results print
    sorted by path, as fd prints a walk that ends inside its buffering
    window; a directory ends in ``/``. A search path that is not a
    directory is reported and skipped.

    Args:
        paths (list[PathSpec]): the search paths; none searches the cwd.
        texts (Sequence[str]): the pattern operand, when typed.
        ctx (Context): the invocation's context.
        readdir (Callable): the directory reader.
        stat (Callable): the stat reader.
    """
    fl = FlagView(ctx.flags, spec=SPECS["fd"])
    try:
        f = parse_flags(fl, texts)
        matcher = _Matcher(f)
    except UsageError as exc:
        return None, IOResult(
            exit_code=exc.exit_code, stderr=encode_text(f"{exc}\n")
        )
    dispatch = dispatch_of(ctx)
    cwd = ctx.cwd.virtual
    mounts = mounts_of(ctx)
    rd = mount_parent_readdir(
        lambda path: readdir(to_pathspec(path)), mounts, mount_root(ctx)
    )
    st = mount_parent_stat(lambda path: stat(to_pathspec(path)), mounts)
    walk = WalkFilter(
        Overrides([f"!{glob}" for glob in f.excludes], [], False),
        FileTypes([], []),
        f.hidden,
        f.max_depth,
        None,
        True,
        await _ignore_rules_of(f.ignore_files, dispatch),
    )
    err = bytearray()
    roots: list[tuple[PathSpec, str]] = []
    for p in paths or [ctx.cwd]:
        typed = bool(paths)
        try:
            is_dir = (await st(p.virtual)).type == FileType.DIRECTORY
        except WALK_ERRORS as exc:
            logger.debug("fd: cannot stat %s: %s", p.raw_path, exc)
            is_dir = False
        if not is_dir:
            err.extend(
                encode_text(
                    f"[fd error]: Search path '{p.raw_path}' is not a "
                    "directory.\n"
                )
            )
            continue
        roots.append((p, _root_shown(p.raw_path) if typed else ""))
    if not roots:
        err.extend(b"[fd error]: No valid search paths given.\n")
        return None, IOResult(exit_code=1, stderr=bytes(err))
    warnings: list[str] = []
    resolver = link_resolver(ctx)
    reader = ignore_reader(dispatch)
    ignore = None if reader is None else (f.sources, reader)
    found: list[_Result] = []
    readdir_path = vfs_readdir_path(ctx.vfs)
    stat_path = vfs_stat_path(ctx.vfs)
    for root, shown_root in roots:
        home = None if mounts is None else mounts.root_of(root.virtual)

        def crosses(path: str, home: str | None = home) -> bool:
            return (
                mounts is not None
                and home is not None
                and mounts.root_of(path) != home
            )

        async def walk_rd(path: str, home: str | None = home) -> list[str]:
            if readdir_path is not None and crosses(path, home):
                return await readdir_path(path)
            return await rd(path)

        async def walk_st(path: str, home: str | None = home) -> FileStat:
            if stat_path is not None and crosses(path, home):
                found = await stat_path(path)
                if found is None:
                    raise enoent(path)
                return found
            return await st(path)

        async for hit in walk_haystacks(
            walk_rd,
            walk_st,
            root.virtual,
            shown_root,
            cwd,
            walk,
            False,
            warnings,
            None,
            resolver,
            f.follow,
            True,
            ignore,
            entries=True,
        ):
            if await _kept(hit, f, matcher, cwd, walk_rd):
                is_dir = (
                    hit.stat is not None
                    and hit.stat.type == FileType.DIRECTORY
                )
                found.append(_Result(hit.shown, is_dir, not shown_root))
                if f.quiet:
                    break
        if f.quiet and found:
            break
    for line in warnings:
        logger.debug("fd: %s", line)
    if f.quiet:
        return None, IOResult(exit_code=0 if found else 1, stderr=bytes(err))
    found.sort(key=lambda r: _sort_key(r.path))
    if f.max_results is not None:
        found = found[: f.max_results]
    prefixed = f.strip_prefix == "never" or (
        f.strip_prefix == "auto"
        and (f.print0 or f.exec_words is not None or f.batch_words is not None)
    )

    def spelled(result: _Result) -> str:
        if f.absolute:
            return _absolute(result.path, cwd)
        if prefixed and result.implicit:
            return "./" + result.path
        return result.path

    out = bytearray()
    if f.exec_words is not None:
        ok = True
        for result in found:
            ok = (
                await _run(
                    ctx.shell,
                    exec_argv(f.exec_words, spelled(result)),
                    out,
                    err,
                )
                and ok
            )
        return bytes(out), IOResult(
            exit_code=0 if ok else 1, stderr=bytes(err)
        )
    if f.batch_words is not None:
        ok = True
        if found:
            ok = await _run(
                ctx.shell,
                batch_argv(f.batch_words, [spelled(r) for r in found]),
                out,
                err,
            )
        return bytes(out), IOResult(
            exit_code=0 if ok else 1, stderr=bytes(err)
        )
    end = b"\0" if f.print0 else b"\n"
    for result in found:
        mark = (
            "/" if result.is_dir and not spelled(result).endswith("/") else ""
        )
        out.extend(encode_text(spelled(result) + mark) + end)
    return bytes(out), IOResult(stderr=bytes(err))


__all__ = ["facts", "fd_generic"]
