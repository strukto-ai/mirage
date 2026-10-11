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
from collections.abc import Mapping, Sequence
from typing import Literal, cast

from mirage.commands.builtin.constants import PatternType
from mirage.commands.builtin.grep_prefilter import (
    UNICODE_FOLDED,
    folds_by_unicode,
    required_needles,
)
from mirage.commands.builtin.types import (
    GrepSearchMeta,
    GrepSearchOptions,
    RegexSyntax,
)
from mirage.commands.builtin.utils.paths import has_unresolved_glob
from mirage.commands.builtin.utils.stream import is_stdin
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.types import PathSpec
from mirage.vfs.types import SearchOps, SearchQuery


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


# grep's dests, then rg's, which spells each flag by its long name; a
# spec-less view reads both, and neither command sets the other's.
_PUSHDOWN_SHAPING_BOOL = (
    "v",
    "n",
    "byte_offset",
    "c",
    "args_l",
    "files_without_match",
    "w",
    "o",
    "q",
    "no_messages",
    "H",
    "h",
    "args_I",
    "text",
    "invert_match",
    "line_number",
    "count",
    "files_with_matches",
    "word_regexp",
    "only_matching",
    "quiet",
    "with_filename",
    "no_filename",
    "line_regexp",
    "column",
    "vimgrep",
    "trim",
    "null",
    "count_matches",
    "include_zero",
    "files",
    "type_list",
    "heading",
    "passthru",
    "passthrough",
    "binary",
    "sort_files",
    "follow",
)
_PUSHDOWN_SHAPING_INT = ("m", "A", "B", "C")
# rg's valued options defer on presence alone: a value the generic would
# refuse in ripgrep's words is not the push-down's to parse.
_PUSHDOWN_SHAPING_VALUE = (
    "max_count",
    "after_context",
    "before_context",
    "context",
    "max_columns",
    "replace",
    "field_match_separator",
    "max_depth",
    "max_filesize",
    "sort",
    "sortr",
)
_PUSHDOWN_FILTER_STR = ("binary_files",)
# -f adds patterns the pushed-down one never carried.
_PUSHDOWN_FILTER_LIST = (
    "include",
    "exclude",
    "exclude_dir",
    "file",
    "glob",
    "iglob",
    "type",
    "type_not",
)


def has_search_shaping_flags(
    flags: Mapping[str, FlagValue] | None,
    honored: Sequence[str] = (),
) -> bool:
    """True when a flag alters the match set or output shape of grep/rg.

    A search push-down prints each matching record as one whole line, so it
    cannot honor -v/-n/-b/-c/-l/-w/-o/-m/-A/-B/-C/-q/-H/-h, rg's -I (no
    filename), -x, -r, --column and the rest of its output options, nor
    the file filters (--include/--exclude, rg's -g/-t/-T/-d), the patterns
    -f adds, or rg's -L, which walks links no backend can see; when any is
    present the wrapper must defer to the generic scan, which applies exact
    semantics. Reads through a spec-less FlagView so the shared key set
    works for both the grep and rg specs (each simply never sets the
    other's keys).

    ``honored`` names the flags this particular push-down implements itself,
    so their presence is not a reason to defer. Two shapes need it. A provider
    whose search is word-based (gmail, slack, discord) is faithful only *with*
    ``-w``, so for those the flag in this list is the one that turns the
    push-down on rather than off. A push-down that uses the search only to
    pick candidates and then runs the real compiled matcher over each one
    (email) honors whatever that local scan implements. Everything left out of
    the list still defers, which is what keeps the exemption honest.

    Args:
        flags (Mapping[str, FlagValue] | None): raw flag kwargs.
        honored (Sequence[str]): dests this push-down reproduces exactly.
    """
    fl = FlagView(flags)
    if any(fl.as_bool(k) for k in _PUSHDOWN_SHAPING_BOOL if k not in honored):
        return True
    if any(
        fl.as_int(k) is not None
        for k in _PUSHDOWN_SHAPING_INT
        if k not in honored
    ):
        return True
    if any(
        fl.raw(k) is not None
        for k in _PUSHDOWN_SHAPING_VALUE
        if k not in honored
    ):
        return True
    if any(fl.as_list(k) for k in _PUSHDOWN_FILTER_LIST if k not in honored):
        return True
    return any(
        fl.as_str(k) is not None
        for k in _PUSHDOWN_FILTER_STR
        if k not in honored
    )


def search_pushdown_ok(
    flags: Mapping[str, FlagValue] | None, pattern: str
) -> bool:
    """True when a literal-substring push-down faithfully reproduces grep/rg.

    For the LIKE/ILIKE substring push-down (postgres/mysql), faithful means a
    literal pattern with no shaping flags; a real regex is treated literally
    by LIKE and so must take the generic scan, and a newline-joined pattern
    list (-F with multiple -e) is a set of independent alternatives that LIKE
    cannot express. Backends that push a real regex down (mongodb) gate on
    has_search_shaping_flags alone instead.

    Args:
        flags (Mapping[str, FlagValue] | None): raw flag kwargs.
        pattern (str): the resolved search pattern.
    """
    if "\n" in pattern:
        return False
    fl = FlagView(flags)
    fixed = fl.as_bool("F") or fl.as_bool("fixed_strings")
    return is_literal_pattern(pattern, fixed) and not has_search_shaping_flags(
        flags
    )


def lone_operand(paths: list[PathSpec]) -> PathSpec | None:
    """The one operand a search push-down may answer for, or None.

    A push-down asks the backend a single whole-container question and
    prints its entire answer, so it can only stand in for a line naming
    exactly one operand. Given two it answered for the first and dropped
    the rest in silence (``rg pat /lf/traces /lf/sessions`` reported only
    traces). Running it once per operand is not the fix: several scopes
    map to the same container search (langfuse routes both ``sessions``
    and one ``session`` to "search every session"), so two operands in
    one family would print that container twice. A multi-operand line
    therefore takes the generic scan, which searches each operand in turn
    the way GNU does. A glob operand defers for the older reason: an
    unexpanded pattern segment would be read as a literal entity name.
    A ``-`` operand defers because it is the line's stdin, which no
    backend holds: asked about ``<mount>/-``, the search answered "no
    match" and the pipe was never read.

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


def pushdown_operand(
    paths: list[PathSpec],
    flags: Mapping[str, FlagValue] | None,
    pattern: str | None,
    honored: Sequence[str] = (),
) -> PathSpec | None:
    """The operand a regex push-down may answer for, or None.

    For a backend that pushes the real regex down (mongodb, langfuse),
    which is faithful for any single pattern with no shaping flags. A
    newline-joined pattern list (-F with several -e) is a set of
    independent alternatives the push-down cannot express.

    Args:
        paths (list[PathSpec]): operands as parsed.
        flags (Mapping[str, FlagValue] | None): raw flag kwargs.
        pattern (str | None): the resolved pattern, None when the line
            supplied none.
        honored (Sequence[str]): dests this push-down reproduces exactly,
            passed through to ``has_search_shaping_flags``.

    Returns:
        PathSpec | None: the operand to push down for, or None to defer.
    """
    if pattern is None or "\n" in pattern:
        return None
    if has_search_shaping_flags(flags, honored):
        return None
    return lone_operand(paths)


def literal_pushdown_operand(
    paths: list[PathSpec],
    flags: Mapping[str, FlagValue] | None,
    pattern: str | None,
) -> PathSpec | None:
    """The operand a literal-substring push-down may answer for, or None.

    ``lone_operand``'s rule plus ``search_pushdown_ok``'s, which is the
    stricter flag gate LIKE/ILIKE needs (postgres): a real regex is
    treated literally by LIKE, so only a verbatim pattern may push down.

    Args:
        paths (list[PathSpec]): operands as parsed.
        flags (Mapping[str, FlagValue] | None): raw flag kwargs.
        pattern (str | None): the resolved pattern, None when the line
            supplied none.

    Returns:
        PathSpec | None: the operand to push down for, or None to defer.
    """
    if pattern is None or not search_pushdown_ok(flags, pattern):
        return None
    return lone_operand(paths)


def text_search_results(lines: Sequence[str]) -> bool:
    """Whether service snippets can be emitted without binary-file handling.

    Args:
        lines (Sequence[str]): Rendered provider search results.
    """
    return all(
        "\0" not in line and not any(0xD800 <= ord(c) <= 0xDFFF for c in line)
        for line in lines
    )


def grep_search_meta(search: SearchOps | None) -> GrepSearchMeta | None:
    """Read grep's opt-in metadata without interpreting other namespaces.

    Args:
        search (SearchOps | None): the resource's optional search capability.
    """
    if search is None or "grep" not in search.meta:
        return None
    meta = search.meta["grep"]
    if not isinstance(meta, dict) or set(meta) - {"mode", "stream"}:
        raise ValueError(
            "search.meta.grep must contain mode and optional stream"
        )
    mode = meta.get("mode")
    stream = meta.get("stream", False)
    if mode not in ("literal", "regex") or not isinstance(stream, bool):
        raise ValueError(
            "search.meta.grep requires mode=literal|regex and boolean stream"
        )
    return GrepSearchMeta(
        mode=cast(Literal["literal", "regex"], mode), stream=stream
    )


def grep_search_options(query: SearchQuery) -> GrepSearchOptions:
    """Parse grep's options; a plain resource query is literal text.

    Args:
        query (SearchQuery): resource query with optional grep namespace.
    """
    options = query.options.get("grep", {})
    allowed = {"ignore_case", "fixed_string", "whole_word", "syntax", "utf8"}
    if not isinstance(options, dict) or set(options) - allowed:
        raise ValueError("search.options.grep contains unknown options")
    if any(
        not isinstance(value, bool)
        for key, value in options.items()
        if key != "syntax"
    ):
        raise ValueError("search.options.grep values must be boolean")
    syntax = options.get("syntax", RegexSyntax.EXTENDED.value)
    if not isinstance(syntax, str) or syntax not in {
        s.value for s in RegexSyntax
    }:
        raise ValueError("search.options.grep.syntax names no dialect")
    return GrepSearchOptions(
        ignore_case=options.get("ignore_case", False) is True,
        fixed_string=options.get("fixed_string", True) is True,
        whole_word=options.get("whole_word", False) is True,
        syntax=RegexSyntax(syntax),
        utf8=options.get("utf8", False) is True,
    )
