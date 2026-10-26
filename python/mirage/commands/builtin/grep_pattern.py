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

from collections.abc import Sequence

from mirage.commands.builtin.types import RegexSyntax
from mirage.commands.builtin.utils.operands import materialized_read
from mirage.commands.errors import UsageError
from mirage.commands.spec.flag_view import FlagView
from mirage.rs.errors import RegexError
from mirage.rs.regex import LineRegex, LineSyntax
from mirage.shell.bytes import decode_text
from mirage.types import PathSpec, PolymorphicReadFn

NEVER_MATCH = r"(?!)"
# The matcher options, as GNU grep names them: each one picks the
# dialect, and two different ones on a line are refused.
MATCHERS = {"E": RegexSyntax.EXTENDED, "P": RegexSyntax.PERL}
CONFLICTING_MATCHERS = "conflicting matchers specified"


def pattern_arg(texts: Sequence[str], flags: FlagView) -> str | None:
    """Resolve the pattern-list argument from -e values or the positional.

    Args:
        texts (Sequence[str]): positional TEXT operands.
        flags (FlagView): typed view over raw flag kwargs.

    Returns:
        str | None: POSIX newline-joined pattern list (each -e value may
            itself be a newline-separated list), or None when neither -e nor
            a positional pattern was supplied.
    """
    e_values = flags.as_list("regexp")
    if e_values:
        return "\n".join(e_values)
    if texts:
        return texts[0]
    return None


async def resolve_pattern(
    texts: Sequence[str],
    flags: FlagView,
    read_bytes: PolymorphicReadFn,
    usage: str,
) -> tuple[str, bool]:
    """Resolve the search pattern from -e/positional/-f flag arguments.

    Args:
        texts (Sequence[str]): positional TEXT operands.
        flags (FlagView): typed view over raw flag kwargs.
        read_bytes (PolymorphicReadFn): bound reader for -f pattern files.
        usage (str): usage error message when no pattern was supplied.

    Returns:
        tuple[str, bool]: (newline-separated pattern list, never_match) where
            never_match is True when -f supplied zero patterns (GNU: match
            nothing; -F escaping must be skipped for the sentinel).
    """
    pattern = pattern_arg(texts, flags)

    pattern_file = flags.raw("file")
    if isinstance(pattern_file, (PathSpec, list)):
        raw = (
            pattern_file if isinstance(pattern_file, list) else [pattern_file]
        )
        read = materialized_read(read_bytes)
        for pf in [item for item in raw if isinstance(item, PathSpec)]:
            pattern = merge_pattern_list(pattern, await read(pf))
        if pattern is None:
            return NEVER_MATCH, True
    if pattern is None:
        raise UsageError(usage)
    return pattern, False


def merge_pattern_list(
    pattern: str | None,
    file_data: bytes | None,
) -> str | None:
    """Merge a pattern list with the content of a -f pattern file.

    Args:
        pattern (str | None): newline-separated pattern list from -e or the
            positional argument, or None when only -f supplied patterns.
        file_data (bytes | None): raw -f file content, or None without -f.

    Returns:
        str | None: merged newline-separated pattern list, or None when the
            list is empty (GNU: zero patterns match nothing).
    """
    parts: list[str] = [] if pattern is None else pattern.split("\n")
    if file_data:
        text = decode_text(file_data)
        if text.endswith("\n"):
            text = text[:-1]
        parts.extend(text.split("\n"))
    if not parts:
        return None
    return "\n".join(parts)


def matcher_syntax(fl: FlagView, prog: str = "grep") -> RegexSyntax:
    """The dialect grep's matcher options pick, refusing a mixture.

    GNU grep 3.11 keeps one matcher: -G, -E, -F and -P each name one,
    repeating the same is harmless, and any two different ones are
    ``conflicting matchers specified`` (exit 2) in either order. -F is
    carried as ``fixed_string``, so it only takes part in the check.

    Args:
        fl (FlagView): the grep (or zgrep) flag view.
        prog (str): the name the refusal carries.

    Raises:
        UsageError: two different matchers were given.
    """
    dests = {
        "basic_regexp": "G",
        "extended_regexp": "E",
        "fixed_strings": "F",
        "perl_regexp": "P",
    }
    chosen = {matcher for dest, matcher in dests.items() if fl.as_bool(dest)}
    if len(chosen) > 1:
        raise UsageError(f"{prog}: {CONFLICTING_MATCHERS}")
    for matcher in chosen:
        if matcher in MATCHERS:
            return MATCHERS[matcher]
    return RegexSyntax.BASIC


def pattern_warnings(matcher: LineRegex, prog: str = "grep") -> bytes:
    """GNU grep's compile-time warnings for a pattern list, as stderr.

    Only an extended expression has any: GNU warns about a repetition
    operator at the start of an expression (`grep: warning: * at start
    of expression`), once per occurrence, which is also how GNU reads
    `(?<=...)`.

    Args:
        matcher (LineRegex): the compiled pattern list.
        prog (str): the name the warning carries.
    """
    return "".join(
        f"{prog}: warning: {w}\n" for w in matcher.warnings
    ).encode()


async def line_selected(matcher: LineRegex, line: str) -> bool:
    """Whether a pattern list selects one line.

    Args:
        matcher (LineRegex): the compiled pattern list.
        line (str): the line as a byte view, without its terminator.
    """
    return await matcher.matches(line)


async def line_pieces(matcher: LineRegex, line: str) -> list[tuple[int, str]]:
    """What -o prints from one line: each match's start and text.

    Args:
        matcher (LineRegex): the compiled pattern list.
        line (str): the line as a byte view, without its terminator.
    """
    extents = await matcher.extents(line)
    return [(start, line[start:end]) for start, end in extents]


def compile_pattern(
    pattern: str,
    ignore_case: bool = False,
    fixed_string: bool = False,
    whole_word: bool = False,
    syntax: RegexSyntax = RegexSyntax.EXTENDED,
    utf8: bool = False,
    line_regexp: bool = False,
) -> LineRegex:
    """Compile a pattern list into one matcher.

    A refusal is GNU grep's wording, and exits 2 as grep does.

    Args:
        pattern (str): newline-separated pattern list.
        ignore_case (bool): True if -i flag is set.
        fixed_string (bool): True if -F flag is set.
        whole_word (bool): True if -w flag is set.
        syntax (RegexSyntax): the dialect the patterns are written in.
        utf8 (bool): the lines are text under a UTF-8 locale.
        line_regexp (bool): -x, which overrides -w and spans the whole line.

    Raises:
        UsageError: a pattern GNU grep refuses.
    """
    # GNU grep 3.11: -x overrides -w in either order.
    whole_word = whole_word and not line_regexp
    kind: LineSyntax = (
        "fixed"
        if fixed_string
        else "perl"
        if syntax is RegexSyntax.PERL
        else "basic"
        if syntax is RegexSyntax.BASIC
        else "extended"
    )
    try:
        return LineRegex(
            pattern.split("\n"),
            kind,
            ignore_case,
            utf8,
            whole_word,
            line_regexp,
        )
    except RegexError as exc:
        raise UsageError(f"grep: {exc.message}") from exc
