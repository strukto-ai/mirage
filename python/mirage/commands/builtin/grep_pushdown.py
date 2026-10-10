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

from mirage.commands.builtin.constants import PatternType
from mirage.commands.builtin.grep_prefilter import (
    UNICODE_FOLDED,
    folds_by_unicode,
    required_needles,
)
from mirage.commands.builtin.utils.paths import has_unresolved_glob
from mirage.commands.builtin.utils.stream import is_stdin
from mirage.types import PathSpec


def classify_pattern(
    pattern: str,
    fixed_string: bool,
) -> PatternType:
    """Classify a grep pattern for API push-down decisions.

    Args:
        pattern (str): the search pattern.
        fixed_string (bool): True if -F flag is set.

    Returns:
        PatternType: EXACT, SIMPLE, or REGEX.
    """
    if "\n" in pattern:
        return PatternType.REGEX
    if fixed_string:
        return PatternType.EXACT
    if re.fullmatch(r"[\w\s\-_.]+", pattern):
        return PatternType.SIMPLE
    return PatternType.REGEX


_MIN_SEARCH_LITERAL = 3


def is_literal_pattern(pattern: str, fixed_string: bool) -> bool:
    """Whether the pattern is searched verbatim, with no regex extraction.

    Push-down against a whole-word search index is only complete when the term
    handed to the provider is the entire match. A regex narrowed on an
    extracted literal fails that: ``foo[0-9]`` under -w matches ``foo1``, but a
    whole-word search for ``foo`` never returns a file whose only token is
    ``foo1``.

    Args:
        pattern (str): the search pattern.
        fixed_string (bool): True if -F is set.

    Returns:
        bool: True when the pattern itself is the search term.
    """
    if fixed_string:
        return True
    pt = classify_pattern(pattern, fixed_string)
    return pt == PatternType.EXACT or (
        pt == PatternType.SIMPLE and "." not in pattern
    )


def whole_word_literals(
    pattern: str | None,
    fixed_string: bool,
    whole_word: bool,
    line_regexp: bool = False,
) -> list[str] | None:
    """The terms a whole-word search index may narrow a scan on, or None.

    A newline-joined pattern list (several -e, or the lines of -f)
    matches a line when any one alternative does, so one search per
    alternative, unioned, is complete when every alternative is itself a
    whole-word literal. -x narrows as -w does: a line that is the literal
    entire is a word match of it. An empty alternative matches every
    line, which no search can stand in for.

    Args:
        pattern (str | None): the newline-joined patterns, or None.
        fixed_string (bool): True if -F is set.
        whole_word (bool): True if -w is set.
        line_regexp (bool): True if -x is set.

    Returns:
        list[str] | None: each distinct alternative in order, or None when
            no union of searches is complete.
    """
    if pattern is None or not (whole_word or line_regexp):
        return None
    terms = pattern.split("\n")
    if any(not t or not is_literal_pattern(t, fixed_string) for t in terms):
        return None
    return list(dict.fromkeys(terms))


def search_terms(
    pattern: str | None,
    matcher: re.Pattern[str],
    fixed_string: bool,
    whole_word: bool,
    line_regexp: bool,
    ignore_case: bool,
) -> tuple[tuple[str, ...], bool] | None:
    """The texts a mount's search is asked for, and whether as whole words.

    Literals under -w or -x are asked as whole words, which a word index
    can answer; any other pattern is narrowed on the needles one of which
    every match contains, asked anywhere. Under -i a literal with a
    non-ASCII letter, or with i, k or s when case folds by Unicode (``ſ``
    matches ``s``), is left to the scan, since a mount's case folding need
    not be grep's.

    Args:
        pattern (str | None): the newline-joined patterns.
        matcher (re.Pattern[str]): the compiled line matcher.
        fixed_string (bool): True if -F is set.
        whole_word (bool): True if -w is set.
        line_regexp (bool): True if -x is set.
        ignore_case (bool): the match folds case.
    """
    words = whole_word_literals(pattern, fixed_string, whole_word, line_regexp)
    if words is not None and not (
        ignore_case
        and not all(
            w.isascii()
            and not (
                folds_by_unicode(matcher) and UNICODE_FOLDED & set(w.lower())
            )
            for w in words
        )
    ):
        return tuple(words), True
    needles = required_needles(matcher)
    if needles is None or any(len(n) < _MIN_SEARCH_LITERAL for n in needles):
        return None
    return tuple(n.decode("ascii") for n in needles), False


def lone_operand(paths: list[PathSpec]) -> PathSpec | None:
    """The one operand a search push-down may answer for, or None.

    A push-down asks the backend a single whole-container question and
    prints its entire answer, so it can only stand in for a line naming
    exactly one operand; given two it answers for the first and drops
    the rest in silence. A glob operand defers since an unexpanded
    pattern segment would be read as a literal name, and a ``-`` operand
    since it is the line's stdin, which no backend holds.

    Args:
        paths (list[PathSpec]): operands as parsed.

    Returns:
        PathSpec | None: the sole concrete operand, or None when the line
            named none, named several, named stdin, or still carries a
            glob.
    """
    if (
        len(paths) != 1
        or has_unresolved_glob(paths)
        or any(is_stdin(p) for p in paths)
    ):
        return None
    return paths[0]
