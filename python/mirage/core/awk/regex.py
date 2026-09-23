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

from mirage.core.awk.errors import AwkSyntaxError
from mirage.utils.posix import POSIX_CLASSES, translate_bracket

WORD_BOUNDARY_ESCAPES = {"y": "\\b", "<": "\\b", ">": "\\b", "B": "\\B"}

ALNUM = ("abcdefghijklmnopqrstuvwxyz"
         "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")

REGEX_ERROR = ("awk: syntax error in regular expression {pattern} "
               "at source line 1")

CACHE: dict[str, re.Pattern[str]] = {}


def translate(pattern: str) -> str:
    """Translate a POSIX ERE into an equivalent Python regex.

    Expands POSIX character classes, which neither Python nor JavaScript
    understands natively and which would otherwise silently match
    nothing. An ERE ``$`` is the end of the subject, so it becomes
    ``\\Z``; Python's own ``$`` also matches before a final newline.

    Args:
        pattern (str): the ERE source.

    Returns:
        str: a Python-compatible pattern.
    """
    out: list[str] = []
    idx = 0
    while idx < len(pattern):
        ch = pattern[idx]
        if ch == "[":
            idx = translate_bracket(pattern, idx, out)
            continue
        if ch == "\\" and idx + 1 < len(pattern):
            nxt = pattern[idx + 1]
            if nxt in WORD_BOUNDARY_ESCAPES:
                out.append(WORD_BOUNDARY_ESCAPES[nxt])
            elif nxt in ALNUM:
                out.append("\\" + nxt)
            else:
                out.append(re.escape(nxt))
            idx += 2
            continue
        out.append("\\Z" if ch == "$" else ch)
        idx += 1
    return "".join(out)


def compile_ere(pattern: str) -> re.Pattern[str]:
    """Compile an ERE, caching the translated pattern.

    Args:
        pattern (str): the ERE source.

    Returns:
        re.Pattern[str]: the compiled pattern.
    """
    cached = CACHE.get(pattern)
    if cached is not None:
        return cached
    try:
        compiled = re.compile(translate(pattern), re.DOTALL)
    except re.error as exc:
        raise AwkSyntaxError(REGEX_ERROR.format(pattern=pattern)) from exc
    CACHE[pattern] = compiled
    return compiled


def matches(pattern: str, subject: str) -> bool:
    """Report whether an ERE matches anywhere in the subject.

    Args:
        pattern (str): the ERE source.
        subject (str): the text to search.
    """
    return compile_ere(pattern).search(subject) is not None


def split_pattern(separator: str) -> re.Pattern[str] | None:
    """Build the field-splitting pattern for an FS value.

    A single character FS is literal per POSIX, so it is escaped rather
    than treated as an ERE. The default blank FS returns None, meaning
    the caller should use the split-on-runs-of-blanks rule instead.

    Args:
        separator (str): the FS value.

    Returns:
        re.Pattern[str] | None: pattern, or None for default splitting.
    """
    if separator == " ":
        return None
    if len(separator) == 1:
        if separator == "\t":
            return compile_ere("\t")
        return compile_ere(re.escape(separator))
    return compile_ere(separator)


__all__ = [
    "POSIX_CLASSES",
    "compile_ere",
    "matches",
    "split_pattern",
    "translate",
    "translate_bracket",
]
