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

import re
from collections.abc import Awaitable, Callable, Sequence

from mirage.commands.builtin.types import RegexSyntax
from mirage.commands.builtin.utils.bre import (
    BreError,
    translate_bre,
    translate_ere,
)
from mirage.commands.builtin.utils.pcre import PcreError, translate_pcre
from mirage.commands.builtin.utils.rust_regex import (
    RustRegexError,
    translate_rust,
    whole_word,
)
from mirage.commands.builtin.utils.types import HostRegex
from mirage.commands.builtin.utils.wrap import call_read_bytes
from mirage.commands.errors import UsageError
from mirage.commands.spec.flag_view import FlagView
from mirage.shell.bytes import decode_text
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.utils.posix import compile_posix_regex

NEVER_MATCH = r"(?!)"
# The matcher options, as GNU grep names them: each one picks the
# dialect, and two different ones on a line are refused.
MATCHERS = {"E": RegexSyntax.EXTENDED, "P": RegexSyntax.PERL}
CONFLICTING_MATCHERS = "conflicting matchers specified"
PERL_SINGLE = "the -P option only supports a single pattern"
# GNU grep 3.11's -P wrapping for -w (pcresearch.c).
PERL_WORD = ("(?<!\\w)(?:", ")(?!\\w)")
# The dest -e fills in each search command's spec: rg spells its options
# by their long names.
PATTERN_KEYS = {"grep": "e", "zgrep": "e", "rg": "regexp"}


def pattern_arg(
    texts: Sequence[str], flags: FlagView, pattern_key: str = "e"
) -> str | None:
    """Resolve the pattern-list argument from -e values or the positional.

    Args:
        texts (Sequence[str]): positional TEXT operands.
        flags (FlagView): typed view over raw flag kwargs.
        pattern_key (str): the dest -e fills (rg's is ``regexp``).

    Returns:
        str | None: POSIX newline-joined pattern list (each -e value may
            itself be a newline-separated list), or None when neither -e nor
            a positional pattern was supplied.
    """
    e_values = flags.as_list(pattern_key)
    if e_values:
        return "\n".join(e_values)
    if texts:
        return texts[0]
    return None


async def resolve_pattern(
    texts: Sequence[str],
    flags: FlagView,
    read_bytes: Callable[[PathSpec], Awaitable[bytes]],
    usage: str,
    file_key: str = "f",
    pattern_key: str = "e",
) -> tuple[str, bool]:
    """Resolve the search pattern from -e/positional/-f flag arguments.

    Args:
        texts (Sequence[str]): positional TEXT operands.
        flags (FlagView): typed view over raw flag kwargs.
        read_bytes (Callable[[PathSpec], Awaitable[bytes]]): bound
            whole-file reader used for -f pattern files.
        usage (str): usage error message when no pattern was supplied.
        file_key (str): canonical option key for pattern files.
        pattern_key (str): canonical option key for -e patterns.

    Returns:
        tuple[str, bool]: (newline-separated pattern list, never_match) where
            never_match is True when -f supplied zero patterns (GNU: match
            nothing; -F escaping must be skipped for the sentinel).
    """
    pattern = pattern_arg(texts, flags, pattern_key)

    pattern_file = flags.raw(file_key)
    if isinstance(pattern_file, (PathSpec, list)):
        raw = (
            pattern_file if isinstance(pattern_file, list) else [pattern_file]
        )
        for pf in [item for item in raw if isinstance(item, PathSpec)]:
            file_data = await call_read_bytes(
                read_bytes, pf, prefix=mount_prefix_of(pf.virtual, pf.vfs_path)
            )
            pattern = merge_pattern_list(pattern, file_data)
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


def bre_source(part: str) -> str:
    """One basic expression as grep reads it, or grep's refusal.

    The shared translator that `expr` and `nl` compile their patterns
    with, asked for grep's dialect: the two GNU dialects agree on every
    construct measured except an inverted range, which grep refuses
    (`grep '[z-a]'` is `Invalid range end`) where the other two read it
    as an empty set.

    A refusal is glibc's `regerror` string verbatim, which is what GNU
    prints, and exits 2 as grep does rather than letting the host
    engine's own wording out (`missing ), unterminated subpattern at
    position 0` was what `grep '\\('` used to say).

    Args:
        part (str): a single basic expression from the pattern list.

    Returns:
        str: the host regex source for that expression.

    Raises:
        UsageError: the pattern is one glibc's compiler would refuse.
    """
    try:
        return translate_bre(part, True)[0]
    except BreError as exc:
        raise UsageError(f"grep: {exc}") from exc


def ere_source(part: str) -> str:
    """One extended expression as grep -E reads it, or grep's refusal.

    Args:
        part (str): a single extended expression from the pattern list.

    Raises:
        UsageError: the pattern is one glibc's compiler would refuse.
    """
    try:
        return translate_ere(part)[0]
    except BreError as exc:
        raise UsageError(f"grep: {exc}") from exc


def matcher_syntax(
    fl: FlagView, prog: str = "grep", perl: str = "perl_regexp"
) -> RegexSyntax:
    """The dialect grep's matcher options pick, refusing a mixture.

    GNU grep 3.11 keeps one matcher: -G, -E, -F and -P each name one,
    repeating the same is harmless, and any two different ones are
    ``conflicting matchers specified`` (exit 2) in either order. -F is
    carried as ``fixed_string``, so it only takes part in the check.

    Args:
        fl (FlagView): the grep (or zgrep) flag view.
        prog (str): the name the refusal carries.
        perl (str): the dest -P fills in this spec (grep's has a long
            spelling, zgrep's does not).

    Raises:
        UsageError: two different matchers were given.
    """
    dests = {"G": "G", "E": "E", "F": "F", perl: "P"}
    if perl == "perl_regexp":
        dests.update(basic_regexp="G", extended_regexp="E")
    chosen = {matcher for dest, matcher in dests.items() if fl.as_bool(dest)}
    if len(chosen) > 1:
        raise UsageError(f"{prog}: {CONFLICTING_MATCHERS}")
    for matcher in chosen:
        if matcher in MATCHERS:
            return MATCHERS[matcher]
    return RegexSyntax.BASIC


def pattern_warnings(
    pattern: str, syntax: RegexSyntax, prog: str = "grep"
) -> bytes:
    """GNU grep's compile-time warnings for a pattern list, as stderr.

    Only an extended expression has any: dfa.c warns about a repetition
    operator at the start of an expression (`grep: warning: * at start
    of expression`), once per occurrence, which is also how GNU reads
    `(?<=...)`.

    Args:
        pattern (str): the newline-separated pattern list.
        syntax (RegexSyntax): its dialect.
        prog (str): the name the warning carries.
    """
    if syntax is not RegexSyntax.EXTENDED:
        return b""
    lines: list[str] = []
    for part in pattern.split("\n"):
        try:
            lines.extend(translate_ere(part)[2])
        except BreError:
            return b""
    return "".join(f"{prog}: warning: {w}\n" for w in lines).encode()


def _source_of(part: str, fixed_string: bool, syntax: RegexSyntax) -> str:
    """One pattern's regex source, in the syntax it was written in.

    Args:
        part (str): a single pattern from the list.
        fixed_string (bool): True if -F flag is set.
        syntax (RegexSyntax): BASIC or EXTENDED.
    """
    if fixed_string:
        return re.escape(part)
    if syntax is RegexSyntax.BASIC:
        return bre_source(part)
    return ere_source(part)


def perl_regex(
    pattern: str, ignore_case: bool, whole: bool, unicode: bool = False
) -> tuple[str, bool]:
    """grep -P's one pattern as host source, or grep's refusal.

    Args:
        pattern (str): the pattern (a list of one).
        ignore_case (bool): -i.
        whole (bool): -w, wrapped the way GNU grep wraps it.
        unicode (bool): UCP classes (a pushed-down rg -P).

    Returns:
        tuple[str, bool]: the host source and whether the host must fold
            case (a caseless back-reference).

    Raises:
        UsageError: more than one pattern, or PCRE2 refuses it.
    """
    if "\n" in pattern:
        raise UsageError(f"grep: {PERL_SINGLE}")
    source = PERL_WORD[0] + pattern + PERL_WORD[1] if whole else pattern
    try:
        translated = translate_pcre(source, unicode, ignore_case)
    except PcreError as exc:
        raise UsageError(f"grep: {exc.message}") from exc
    return translated.source, translated.ignore_case


def rust_source(
    pattern: str, fixed_string: bool, whole: bool, ignore_case: bool
) -> HostRegex:
    """ripgrep's default-engine pattern list as host source.

    Args:
        pattern (str): the newline-separated pattern list.
        fixed_string (bool): -F.
        whole (bool): -w, ripgrep's half word boundaries.
        ignore_case (bool): -i or smart case.

    Raises:
        UsageError: ripgrep refuses the pattern.
    """
    parts = pattern.split("\n")
    if fixed_string:
        parts = [rust_escape(part) for part in parts]
    try:
        translated = translate_rust(parts, ignore_case)
    except RustRegexError as exc:
        raise UsageError(f"rg: {exc}") from exc
    if not whole:
        return translated
    return HostRegex(whole_word(translated.source), translated.ignore_case)


def rust_escape(text: str) -> str:
    """A literal as a Rust regex, the way ``regex::escape`` spells it.

    Args:
        text (str): the literal.
    """
    return "".join(
        "\\" + ch if ch in "\\.+*?()|[]{}^$#&-~" else ch for ch in text
    )


def build_pattern_str(
    pattern: str,
    fixed_string: bool = False,
    whole_word: bool = False,
    syntax: RegexSyntax = RegexSyntax.EXTENDED,
) -> str:
    """Build a regex source string from a POSIX pattern list.

    Args:
        pattern (str): newline-separated pattern list; a line matches when
            any of the patterns matches.
        fixed_string (bool): True if -F flag is set.
        whole_word (bool): True if -w flag is set.
        syntax (RegexSyntax): BASIC or EXTENDED; the other two dialects
            compile through ``compile_pattern``.

    Returns:
        str: regex source string.
    """
    parts = pattern.split("\n")
    if len(parts) == 1:
        pat_str = _source_of(pattern, fixed_string, syntax)
        if whole_word:
            pat_str = r"\b" + pat_str + r"\b"
        return pat_str
    subs: list[str] = []
    for part in parts:
        source = _source_of(part, fixed_string, syntax)
        sub = source if fixed_string else f"(?:{source})"
        if whole_word:
            sub = r"\b" + sub + r"\b"
        subs.append(sub)
    return "|".join(subs)


def compile_pattern(
    pattern: str,
    ignore_case: bool = False,
    fixed_string: bool = False,
    whole_word: bool = False,
    syntax: RegexSyntax = RegexSyntax.EXTENDED,
) -> re.Pattern[str]:
    """Compile a pattern list into one matcher.

    Args:
        pattern (str): newline-separated pattern list.
        ignore_case (bool): True if -i flag is set.
        fixed_string (bool): True if -F flag is set.
        whole_word (bool): True if -w flag is set.
        syntax (RegexSyntax): the dialect the patterns are written in.
    """
    if syntax is RegexSyntax.RUST:
        translated = rust_source(
            pattern, fixed_string, whole_word, ignore_case
        )
        return re.compile(
            translated.source, re.IGNORECASE if translated.ignore_case else 0
        )
    if syntax is RegexSyntax.PERL and not fixed_string:
        source, fold = perl_regex(pattern, ignore_case, whole_word)
        return compile_posix_regex(source, re.IGNORECASE if fold else 0)
    flags = re.IGNORECASE if ignore_case else 0
    source = build_pattern_str(pattern, fixed_string, whole_word, syntax)
    try:
        return compile_posix_regex(source, flags)
    except re.error as exc:
        raise UsageError("grep: Invalid regular expression") from exc
