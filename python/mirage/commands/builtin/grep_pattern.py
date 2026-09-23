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

from mirage.commands.builtin.utils.bre import BreError, translate_bre
from mirage.commands.builtin.utils.wrap import call_read_bytes
from mirage.commands.errors import UsageError
from mirage.commands.spec.flag_view import FlagView
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.utils.posix import translate_classes

NEVER_MATCH = r"(?!)"


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
    e_values = flags.as_list("e")
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
) -> tuple[str, bool]:
    """Resolve the search pattern from -e/positional/-f flag arguments.

    Args:
        texts (Sequence[str]): positional TEXT operands.
        flags (FlagView): typed view over raw flag kwargs.
        read_bytes (Callable[[PathSpec], Awaitable[bytes]]): bound
            whole-file reader used for -f pattern files.
        usage (str): usage error message when no pattern was supplied.

    Returns:
        tuple[str, bool]: (newline-separated pattern list, never_match) where
            never_match is True when -f supplied zero patterns (GNU: match
            nothing; -F escaping must be skipped for the sentinel).
    """
    pattern = pattern_arg(texts, flags)

    pattern_file = flags.raw("f")
    if isinstance(pattern_file, (PathSpec, list)):
        raw = (pattern_file
               if isinstance(pattern_file, list) else [pattern_file])
        for pf in [item for item in raw if isinstance(item, PathSpec)]:
            file_data = await call_read_bytes(read_bytes,
                                              pf,
                                              prefix=mount_prefix_of(
                                                  pf.virtual, pf.vfs_path))
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
        text = file_data.decode(errors="replace")
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


def _source_of(part: str, fixed_string: bool, basic: bool) -> str:
    """One pattern's regex source, in the syntax it was written in.

    Args:
        part (str): a single pattern from the list.
        fixed_string (bool): True if -F flag is set.
        basic (bool): True when the pattern is a basic regular
            expression (grep's default), False for an extended one.
    """
    if fixed_string:
        return re.escape(part)
    if basic:
        return bre_source(part)
    try:
        return translate_classes(part)
    except re.error as exc:
        raise UsageError(f"grep: {exc}") from exc


def build_pattern_str(
    pattern: str,
    fixed_string: bool = False,
    whole_word: bool = False,
    basic: bool = False,
) -> str:
    """Build a regex source string from a POSIX pattern list.

    Args:
        pattern (str): newline-separated pattern list; a line matches when
            any of the patterns matches.
        fixed_string (bool): True if -F flag is set.
        whole_word (bool): True if -w flag is set.
        basic (bool): True when the patterns are basic regular
            expressions, which grep reads by default and which invert
            most of Python's operators. False leaves them alone, which
            is right for -E and for rg's own dialect.

    Returns:
        str: regex source string.
    """
    parts = pattern.split("\n")
    if len(parts) == 1:
        pat_str = _source_of(pattern, fixed_string, basic)
        if whole_word:
            pat_str = r"\b" + pat_str + r"\b"
        return pat_str
    subs: list[str] = []
    for part in parts:
        source = _source_of(part, fixed_string, basic)
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
    basic: bool = False,
) -> re.Pattern[str]:
    """Compile a pattern list into one matcher.

    Args:
        pattern (str): newline-separated pattern list.
        ignore_case (bool): True if -i flag is set.
        fixed_string (bool): True if -F flag is set.
        whole_word (bool): True if -w flag is set.
        basic (bool): True for a basic regular expression.
    """
    # `re.ASCII` because GNU's word boundary and its case folding are the
    # ASCII ones under `LC_ALL=C` while python's defaults are Unicode, and
    # because a non-`u` RegExp is ASCII for both, so the TypeScript twin
    # was already answering GNU's way. Without it `grep -w ab` matched
    # `éab`, `grep -w a` matched `aé`, and `grep -i k` and
    # `grep -i s` matched U+212A and U+017F. `compile_bre` in
    # `utils/bre.py` already passes it; this was grep's own gap.
    flags = re.ASCII | (re.IGNORECASE if ignore_case else 0)
    return re.compile(
        build_pattern_str(pattern, fixed_string, whole_word, basic), flags)
