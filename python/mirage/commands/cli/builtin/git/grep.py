import asyncio
import logging
import posixpath
import re
from collections.abc import Callable
from dataclasses import dataclass

from dulwich.objects import Blob
from dulwich.repo import BaseRepo

from mirage.commands.builtin.grep_pattern import compile_pattern
from mirage.commands.builtin.types import RegexSyntax
from mirage.commands.builtin.utils.bre import (
    BreError,
    PosixSyntax,
    translate_ere,
)
from mirage.commands.cli.builtin.git.discover import require_work_tree
from mirage.commands.cli.builtin.git.errors import (
    AmbiguousArgumentError,
    GitError,
    InvalidRevisionNameError,
    UsageError,
)
from mirage.commands.cli.builtin.git.index_file import read_index
from mirage.commands.cli.builtin.git.io import exists, read_optional
from mirage.commands.cli.builtin.git.patch import blob_data
from mirage.commands.cli.builtin.git.pathspec import (
    pathspec_patterns,
    pathspec_selects,
    repo_relative,
    visible_path,
)
from mirage.commands.cli.builtin.git.render import quote_path
from mirage.commands.cli.builtin.git.repo import config_bool
from mirage.commands.cli.builtin.git.revparse import resolve_object, unwrapped
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.summary import BINARY_SNIFF
from mirage.commands.cli.builtin.git.tree import Tree, flat_tree, resolve_tree
from mirage.commands.cli.builtin.git.util import (
    check_switches,
    fatal,
    split_marked,
    start_point,
    verb_usage,
)
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.errors import UsageError as PatternError
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import (
    byte_view,
    encode_text,
    from_byte_view,
    utf8_locale,
)
from mirage.utils.posix import compile_posix_regex, posix_line_matcher

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class GrepFlags:
    """A compiled search and its presentation, independent of content source.

    Args:
        patterns (tuple[Callable[[str], bool], ...]): alternative line matchers.
        invert (bool): select nonmatching lines.
        numbers (bool): include line numbers.
        count (bool): print each matching file's line count.
        listing (str): names of matching or nonmatching files.
        quiet (bool): stop at the first selected file.
        filename (bool): prefix content with the filename.
        nul (bool): terminate filename and number fields with NUL.
        binary (str): binary, text, or skip.
        utf8 (bool): match characters under a UTF-8 locale.
    """

    patterns: tuple[Callable[[str], bool], ...]
    invert: bool
    numbers: bool
    count: bool
    listing: str
    quiet: bool
    filename: bool
    nul: bool
    binary: str
    utf8: bool


def parse_flags(
    fl: FlagView, patterns: list[str], origin: str, utf8: bool
) -> GrepFlags:
    """Compile patterns once, retaining Git's option precedence and errors.

    Args:
        fl (FlagView): parsed options.
        patterns (list[str]): explicit or positional patterns.
        origin (str): Git's diagnostic label for the pattern source.
        utf8 (bool): match characters under a UTF-8 locale.
    """
    syntax, fixed = RegexSyntax.BASIC, False
    for name, _ in fl.occurrences(
        "basic_regexp", "extended_regexp", "fixed_strings"
    ):
        syntax = (
            RegexSyntax.EXTENDED
            if name == "extended_regexp"
            else RegexSyntax.BASIC
        )
        fixed = name == "fixed_strings"
    ignore_case = fl.as_bool("ignore_case")
    whole_word = fl.as_bool("word_regexp")
    compiled = []
    for value in patterns:
        for part in value.split("\n"):
            try:
                if syntax is RegexSyntax.EXTENDED and not fixed:
                    source = translate_ere(
                        byte_view(part, utf8), PosixSyntax.EXTENDED
                    )[0]
                    pattern = compile_posix_regex(
                        source,
                        re.IGNORECASE if ignore_case else 0,
                        utf8,
                    )
                else:
                    pattern = compile_pattern(
                        byte_view(part, utf8),
                        ignore_case,
                        fixed,
                        False,
                        syntax,
                        utf8,
                    )
                if whole_word:
                    pattern = compile_posix_regex(
                        r"(?<!\w)(?:" + pattern.pattern + r")(?!\w)",
                        pattern.flags,
                        utf8,
                    )
                compiled.append(posix_line_matcher(pattern, whole_word))
            except (PatternError, BreError, re.error) as exc:
                raise GitError(
                    f"{origin}, '{part}': {str(exc).removeprefix('grep: ')}"
                ) from exc
    listing = (
        "files_without_match"
        if fl.as_bool("files_without_match")
        else "files_with_matches"
        if fl.as_bool("files_with_matches")
        else ""
    )
    filename = True
    for name in fl.typed_order("h", "H"):
        filename = name == "H"
    binary = "binary"
    for name in fl.typed_order("text", "args_I"):
        binary = "text" if name == "text" else "skip"
    return GrepFlags(
        tuple(compiled),
        fl.as_bool("invert_match"),
        fl.as_bool("line_number"),
        fl.as_bool("count"),
        listing,
        fl.as_bool("quiet"),
        filename,
        fl.as_bool("null"),
        binary,
        utf8,
    )


def searched(data: bytes, label: str, flags: GrepFlags) -> tuple[bytes, bool]:
    """Select and render one file, preserving its content bytes.

    Args:
        data (bytes): source contents.
        label (str): quoted output name, including revision when present.
        flags (GrepFlags): compiled matching and presentation options.
    """
    binary = b"\0" in data[:BINARY_SNIFF] and flags.binary != "text"
    if binary and flags.binary == "skip":
        return b"", False
    lines = byte_view(data, flags.utf8).split("\n")
    if lines[-1] == "":
        lines.pop()
    selected = [
        (number, line)
        for number, line in enumerate(lines, 1)
        if any(matches(line) for matches in flags.patterns) != flags.invert
    ]
    matched = bool(selected)
    found = not matched if flags.listing == "files_without_match" else matched
    if not found or flags.quiet:
        return b"", found
    name = encode_text(label)
    sep = b"\0" if flags.nul else b":"
    if flags.listing:
        return name + (b"\0" if flags.nul else b"\n"), True
    prefix = name + sep if flags.filename else b""
    if flags.count:
        return prefix + str(len(selected)).encode() + b"\n", True
    if binary:
        return b"Binary file " + name + b" matches\n", True
    return b"".join(
        prefix
        + (str(number).encode() + sep if flags.numbers else b"")
        + from_byte_view(line, flags.utf8)
        + b"\n"
        for number, line in selected
    ), True


def search_entries(repo: BaseRepo, name: str) -> Tree:
    """The searchable leaves of a tree-ish, or a directly named blob.

    Args:
        repo (BaseRepo): opened object database.
        name (str): object name as typed.
    """
    obj = unwrapped(repo, resolve_object(repo, name), name)
    if isinstance(obj, Blob):
        return {b"": (0o100644, obj.id)}
    return flat_tree(repo, resolve_tree(repo, name, obj))


async def grep(inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    """Search tracked working files, index blobs, or named historical trees.

    Args:
        inv (CLIInvocation[None]): parsed search invocation.
    """
    fl = FlagView(inv.flags)
    try:
        check_switches(inv, inv.texts[:1])
        words = list(inv.texts)
        patterns = fl.as_list("e")
        origin = "-e option" if patterns else "command line"
        if patterns:
            before, after = split_marked(inv.texts, inv.argv)
            words, paths = list(before), list(after)
            marked = "--" in inv.argv
            if words and words[-1] == "--":
                words.pop()
        else:
            if not words:
                if fl.as_bool("h"):
                    raise UsageError(verb_usage(inv), "")
                raise GitError("no pattern given")
            patterns = [words.pop(0)]
            marked = "--" in words
            cut = words.index("--") if marked else len(words)
            words, paths = words[:cut], words[cut + 1 :]
        flags = parse_flags(fl, patterns, origin, utf8_locale(inv.env))
        doors = inv.doors or CLIDoors()
        repo, location = await opened(fl, doors)
        assert doors.dispatch is not None
        start = start_point(fl).virtual
        prefix = repo_relative(location, start, ".")
        cached = fl.as_bool("cached")
        sources: list[tuple[str, Tree]] = []
        for index, word in enumerate(words):
            if word.startswith("-"):
                raise GitError(
                    f"option '{word}' must come before non-option arguments"
                )
            try:
                sources.append(
                    (word, await asyncio.to_thread(search_entries, repo, word))
                )
            except (AmbiguousArgumentError, InvalidRevisionNameError) as exc:
                if marked:
                    raise GitError(
                        f"unable to resolve revision: {word}"
                    ) from exc
                relative = repo_relative(location, start, word)
                if not any(
                    char in word for char in "*?["
                ) and not await exists(
                    doors.dispatch, location.worktree.join(relative)
                ):
                    raise AmbiguousArgumentError(word) from exc
                logger.debug("Git grep operand is a pathspec: %s", word)
                paths = words[index:] + paths
                break
        if sources and cached:
            raise GitError("both --cached and trees are given")
        if not sources and not cached:
            assert doors.stat_path is not None
            await require_work_tree(
                doors.dispatch,
                doors.stat_path,
                location,
                fl.as_path("work_tree") is not None,
            )
        specs = pathspec_patterns(location, start, tuple(paths)) or (prefix,)
        fully = await config_bool(
            doors.dispatch, location, b"core", b"quotepath", True
        )
        if not sources:
            state = await read_index(doors.dispatch, location.gitdir)
            entries: Tree = {
                path: (entry.mode, entry.sha)
                for path, entry in state.entries.items()
            }
            if not cached:
                for path, conflict in state.conflicts.items():
                    for entry in (
                        conflict.this,
                        conflict.other,
                        conflict.ancestor,
                    ):
                        if entry is not None and entry.mode in (
                            0o100644,
                            0o100755,
                        ):
                            entries[path] = (entry.mode, entry.sha)
                            break
            sources.append(("", entries))
        out: list[bytes] = []
        found = False
        for revision, entries in sources:
            for path, (mode, oid) in sorted(entries.items()):
                relative = path.decode("utf-8", "surrogateescape")
                if mode not in (0o100644, 0o100755) or (
                    relative
                    and (
                        not visible_path(location, relative)
                        or not pathspec_selects(relative, specs)
                    )
                ):
                    continue
                data: bytes | None
                if revision or cached:
                    data = await asyncio.to_thread(
                        blob_data, repo, (mode, oid)
                    )
                else:
                    target = location.worktree.join(relative)
                    if (
                        location.ns is not None
                        and location.ns.links is not None
                        and location.ns.links.stat_at(target.virtual)
                        is not None
                    ):
                        continue
                    data = await read_optional(doors.dispatch, target)
                    if data is None:
                        continue
                label = posixpath.relpath(relative or revision, prefix or ".")
                if not flags.nul:
                    label = quote_path(label, False, fully)
                if revision and relative:
                    label = revision + ":" + label
                rendered, hit = searched(data, label, flags)
                found = found or hit
                if hit and flags.quiet:
                    return None, IOResult()
                out.append(rendered)
        return b"".join(out), IOResult(exit_code=0 if found else 1)
    except GitError as exc:
        return fatal(exc)
