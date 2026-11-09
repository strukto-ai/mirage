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

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import Any, Callable

from mirage.commands.builtin.utils.constants import MONTHS
from mirage.core.email.client import quote_string
from mirage.types import JsonValue

# himalaya's search DSL: 3 operators (and, or, not) and 7 conditions
# (date, after, from, to, subject, body, flag), optionally followed by
# `order by <kind> [asc|desc]` sorters. Date conditions anchor on the
# `Date:` header, never on the server's received-at timestamp, which is
# why they emit SENTON/SENTSINCE rather than ON/SINCE: imported or
# delayed mail would otherwise land on the wrong day. The parser mirrors
# upstream's combinators, because the expected-token list in its error is
# what a caller reads: the furthest failure wins and every alternative
# tried there is named, in the order it was tried.
FLAGS = {
    "seen": "SEEN",
    "answered": "ANSWERED",
    "flagged": "FLAGGED",
    "draft": "DRAFT",
    "deleted": "DELETED",
}
QUERY_SOURCE = "query"
ORDER_BY = "order by"
DATE_FORMATS = ("%Y-%m-%d", "%Y/%m/%d", "%d-%m-%Y", "%d/%m/%Y")
QUOTED_ESCAPES = '\\"'
UNQUOTED_ESCAPES = "\\ ()"
END_OF_INPUT = "end of input"


class QueryError(ValueError):
    """The query does not parse."""


@dataclass(frozen=True, slots=True)
class Sorter:
    kind: str
    descending: bool


@dataclass(frozen=True, slots=True)
class Query:
    """A parsed search query: an optional filter plus its sorters.

    Args:
        criteria (str): the filter as an IMAP SEARCH key, "ALL" when the
            query carried no filter.
        sorters (tuple[Sorter, ...]): sorters in declaration order, the
            first being the primary key. Empty means the default order.
    """

    criteria: str
    sorters: tuple[Sorter, ...]


def _format_date(value: date) -> str:
    return f"{value.day:02d}-{MONTHS[value.month - 1]}-{value.year}"


def _parse_date_word(text: str) -> date | None:
    for pattern in DATE_FORMATS:
        try:
            return datetime.strptime(text, pattern).date()
        except ValueError:
            continue
    return None


def _quoted_char(char: str) -> str:
    if char == "\\":
        return "'\\\\'"
    if char == "'":
        return "'\\''"
    if char == "\n":
        return "'\\n'"
    if char == "\r":
        return "'\\r'"
    if char == "\t":
        return "'\\t'"
    return f"'{char}'"


def _expected(labels: list[str]) -> str:
    if len(labels) == 1:
        return labels[0]
    return ", ".join(labels[:-1]) + f", or {labels[-1]}"


class _Grammar:
    """The filter and sort grammars, tracking the furthest failure.

    Args:
        source (str): the text being parsed.
    """

    def __init__(self, source: str) -> None:
        self.source = source
        self.best = -1
        self.labels: list[str] = []

    def fail(self, pos: int, label: str) -> None:
        if pos > self.best:
            self.best = pos
            self.labels = [label]
        elif pos == self.best and label not in self.labels:
            self.labels.append(label)

    def at(self, pos: int) -> str | None:
        return self.source[pos] if pos < len(self.source) else None

    def char(self, pos: int, char: str, label: str) -> int | None:
        if self.at(pos) == char:
            return pos + 1
        self.fail(pos, label)
        return None

    def word(self, pos: int, word: str, label: str) -> int | None:
        for offset, char in enumerate(word):
            if self.at(pos + offset) != char:
                self.fail(pos + offset, label)
                return None
        return pos + len(word)

    def spaces(self, pos: int, label: str, at_least: int) -> int | None:
        count = 0
        while self.at(pos) == " ":
            pos += 1
            count += 1
        self.fail(pos, label)
        return pos if count >= at_least else None

    def labelled(
        self,
        label: str,
        start: int,
        parser: Callable[[], tuple[str, int] | None],
    ) -> tuple[str, int] | None:
        best = self.best
        labels = list(self.labels)
        result = parser()
        if result is None and self.best == start:
            self.best = best
            self.labels = labels
            self.fail(start, label)
        return result

    def escaped_run(
        self, pos: int, stops: str, at_least: int
    ) -> tuple[str, int] | None:
        chars: list[str] = []
        while True:
            char = self.at(pos)
            if char == "\\":
                following = self.at(pos + 1)
                if following is None or following not in stops:
                    self.fail(pos + 1, "something else")
                    break
                chars.append(following)
                pos += 2
                continue
            self.fail(pos, "backslash")
            if char is None or char in stops:
                self.fail(pos, "something else")
                break
            chars.append(char)
            pos += 1
        if len(chars) < at_least:
            return None
        return "".join(chars), pos

    def quoted(self, pos: int) -> tuple[str, int] | None:
        after = self.char(pos, '"', "double quote")
        if after is None:
            return None
        body = self.escaped_run(after, QUOTED_ESCAPES, 0)
        if body is None:
            return None
        end = self.char(body[1], '"', "double quote")
        return None if end is None else (body[0], end)

    def unquoted(self, pos: int) -> tuple[str, int] | None:
        return self.escaped_run(pos, UNQUOTED_ESCAPES, 1)

    def pattern(self, pos: int) -> tuple[str, int] | None:
        return self.quoted(pos) or self.unquoted(pos)

    def date_value(self, pos: int) -> tuple[str, int] | None:
        best = self.best
        labels = list(self.labels)
        parsed = self.pattern(pos)
        if parsed is None:
            return None
        value = _parse_date_word(parsed[0])
        if value is None:
            self.best = best
            self.labels = labels
            return None
        return _format_date(value), parsed[1]

    def keyword(
        self,
        pos: int,
        word: str,
        label: str,
        value: Callable[[int], tuple[str, int] | None],
    ) -> tuple[str, int] | None:
        after = self.word(pos, word, f"`{word}`")
        if after is None:
            return None
        after = self.spaces(after, f"space after `{word}`", 1)
        if after is None:
            return None
        start = after
        return self.labelled(label, start, lambda: value(start))

    def date_condition(self, pos: int) -> tuple[str, int] | None:
        found = self.keyword(
            pos, "date", "date format after `date`", self.date_value
        )
        return None if found is None else (f"SENTON {found[0]}", found[1])

    def after_condition(self, pos: int) -> tuple[str, int] | None:
        found = self.keyword(
            pos, "after", "pattern after `after`", self.date_value
        )
        if found is None:
            return None
        day = datetime.strptime(found[0], "%d-%b-%Y").date()
        return f"SENTSINCE {_format_date(day + timedelta(days=1))}", found[1]

    def text_condition(self, pos: int, word: str) -> tuple[str, int] | None:
        found = self.keyword(
            pos, word, f"pattern after `{word}`", self.pattern
        )
        if found is None:
            return None
        return f"{word.upper()} {quote_string(found[0])}", found[1]

    def flag_condition(self, pos: int) -> tuple[str, int] | None:
        found = self.keyword(
            pos, "flag", "flag name after `flag`", self.unquoted
        )
        if found is None:
            return None
        name = found[0].removeprefix("\\").removeprefix("$").lower()
        key = FLAGS.get(name)
        criteria = key if key else f"KEYWORD {found[0]}"
        return criteria, found[1]

    def nested(self, pos: int) -> tuple[str, int] | None:
        after = self.char(pos, "(", "nested filter opening '('")
        if after is None:
            return None
        inner = self.parse_or(after)
        if inner is None:
            return None
        end = self.char(inner[1], ")", "nested filter closing ')'")
        return None if end is None else (inner[0], end)

    def condition(self, pos: int) -> tuple[str, int] | None:
        found = (
            self.date_condition(pos)
            or self.after_condition(pos)
            or self.text_condition(pos, "from")
            or self.text_condition(pos, "to")
            or self.text_condition(pos, "subject")
            or self.text_condition(pos, "body")
            or self.flag_condition(pos)
            or self.labelled("(nested filter)", pos, lambda: self.nested(pos))
        )
        if found is None:
            return None
        end = self.spaces(found[1], "space between filters", 0)
        return None if end is None else (found[0], end)

    def parse_not(self, pos: int) -> tuple[str, int] | None:
        negations = 0
        while True:
            after = self.word(pos, "not", "`not`")
            if after is None:
                break
            after = self.spaces(after, "space after `not`", 1)
            if after is None:
                break
            pos = after
            negations += 1
        found = self.condition(pos)
        if found is None:
            return None
        criteria = found[0]
        for _ in range(negations):
            criteria = f"NOT {criteria}"
        return criteria, found[1]

    def parse_and(self, pos: int) -> tuple[str, int] | None:
        left = self.parse_not(pos)
        if left is None:
            return None
        while True:
            after = self.word(left[1], "and", "`and`")
            if after is None:
                return left
            after = self.spaces(after, "space after `and`", 1)
            if after is None:
                return left
            right = self.parse_not(after)
            if right is None:
                return left
            left = (f"({left[0]} {right[0]})", right[1])

    def parse_or(self, pos: int) -> tuple[str, int] | None:
        left = self.parse_and(pos)
        if left is None:
            return None
        while True:
            after = self.word(left[1], "or", "`or`")
            if after is None:
                return left
            after = self.spaces(after, "space after `or`", 1)
            if after is None:
                return left
            right = self.parse_and(after)
            if right is None:
                return left
            left = (f"OR {left[0]} {right[0]}", right[1])

    def sorter(self, pos: int) -> tuple[Sorter, int] | None:
        for kind in SORT_KINDS:
            after = self.word(pos, kind, f"`{kind}`")
            if after is None:
                continue
            spaced = self.spaces(after, f"space after `{kind}`", 1)
            if spaced is not None:
                ended = self.word(spaced, "asc", "`asc`")
                if ended is not None:
                    return Sorter(kind, False), ended
                ended = self.word(spaced, "desc", "`desc`")
                if ended is not None:
                    return Sorter(kind, True), ended
            return Sorter(kind, False), after
        return None

    def sorters(self, pos: int) -> tuple[tuple[Sorter, ...], int]:
        out: list[Sorter] = []
        found = self.sorter(pos)
        while found is not None:
            out.append(found[0])
            pos = found[1]
            after = self.spaces(pos, "space between sorters", 1)
            if after is None:
                break
            found = self.sorter(after)
            if found is None:
                break
        return tuple(out), pos

    def error(self) -> QueryError:
        found = self.at(self.best)
        shown = END_OF_INPUT if found is None else _quoted_char(found)
        message = f"found {shown} expected {_expected(self.labels)}"
        return QueryError(_report(self.source, self.best, message))


SORT_KINDS = ("date", "from", "to", "subject")


def _report(source: str, pos: int, message: str) -> str:
    gap = " " * pos
    at_end = pos >= len(source)
    marker = "│ " if at_end else "┬  "
    arrow = "╰─" if at_end else "╰──"
    return (
        f"Error: cannot parse search emails query `{source}`\n"
        f"   ╭─[ {QUERY_SOURCE}:1:{pos + 1} ]\n"
        "   │\n"
        f" 1 │ {source}\n"
        f"   │ {gap}{marker}\n"
        f"   │ {gap}{arrow} {message}\n"
        "───╯\n"
    )


def _parse_filter(source: str) -> str:
    grammar = _Grammar(source)
    found = grammar.parse_or(0)
    if found is not None and found[1] == len(source):
        return found[0]
    if found is not None:
        grammar.fail(found[1], END_OF_INPUT)
    raise grammar.error()


def _parse_sort(source: str) -> tuple[Sorter, ...]:
    grammar = _Grammar(source)
    sorters, end = grammar.sorters(0)
    if end == len(source):
        return sorters
    grammar.fail(end, END_OF_INPUT)
    raise grammar.error()


def parse_query(source: str) -> Query:
    """Parse a himalaya search query into IMAP criteria plus sorters.

    Args:
        source (str): the query as typed, tokens already joined by space.

    Raises:
        QueryError: the query does not parse.
    """
    text = source.strip()
    if not text:
        return Query(criteria="ALL", sorters=())
    head, separator, tail = text.rpartition(ORDER_BY)
    if not separator:
        return Query(criteria=_parse_filter(text), sorters=())
    filter_text = head.strip()
    criteria = _parse_filter(filter_text) if filter_text else "ALL"
    return Query(criteria=criteria, sorters=_parse_sort(tail.strip()))


def _sent_at(header: dict[str, Any]) -> float:
    try:
        return parsedate_to_datetime(header.get("date", "")).timestamp()
    except (TypeError, ValueError):
        return 0.0


def _uid_number(header: dict[str, Any]) -> int:
    return int(header.get("uid") or 0)


def _first_email(entries: JsonValue) -> str:
    if isinstance(entries, list) and entries:
        first = entries[0]
        if isinstance(first, dict):
            return str(first.get("email", ""))
    return ""


SORT_KEYS: dict[str, Callable[[dict[str, Any]], Any]] = {
    "date": _sent_at,
    "from": lambda header: str((header.get("from") or {}).get("email", "")),
    "to": lambda header: _first_email(header.get("to")),
    "subject": lambda header: str(header.get("subject", "")),
}


def sort_headers(
    headers: list[dict[str, Any]], sorters: tuple[Sorter, ...]
) -> list[dict[str, Any]]:
    """Order fetched headers by the query's sorters.

    Applied client-side and right to left, so the first sorter ends up
    the primary key (Python's sort is stable). With no sorters the
    order is date descending. Ties stay in mailbox order, lowest UID
    first, the last key RFC 5256 gives a server-side SORT.

    Args:
        headers (list[dict]): envelope headers as fetched.
        sorters (tuple[Sorter, ...]): sorters in declaration order.
    """
    ordered = sorted(headers, key=_uid_number)
    if not sorters:
        ordered.sort(key=_sent_at, reverse=True)
        return ordered
    for sorter in reversed(sorters):
        ordered.sort(key=SORT_KEYS[sorter.kind], reverse=sorter.descending)
    return ordered


def newest_arrivals(headers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Order fetched headers newest arrival first, as `envelope list` does.

    Arrival rather than the `Date:` header, so an old message copied in
    last leads. UIDs only grow within a mailbox, which makes them the
    arrival order exactly.

    Args:
        headers (list[dict]): envelope headers as fetched.
    """
    return sorted(headers, key=_uid_number, reverse=True)


def uid_budget(
    page: int, page_size: int, sorters: tuple[Sorter, ...], max_messages: int
) -> int:
    """How many of the newest matching UIDs to fetch headers for.

    Sorting happens client-side, so a page cannot be served without
    holding the candidate headers. Under the default order (date
    descending) the newest `page * page_size` messages are the only ones
    that can appear, so ask for exactly those. An explicit `order by` is
    unrelated to arrival order, so the whole account window has to be
    considered, capped by `max_messages` either way: that is the account
    knob for how far back mirage looks, and without it one `envelope
    list` would fetch every message in the mailbox.

    Args:
        page (int): 1-based page number.
        page_size (int): maximum entries per page.
        sorters (tuple[Sorter, ...]): the query's sorters, empty for the
            default order.
        max_messages (int): the account's message window.
    """
    if sorters:
        return max_messages
    return min(max(page, 1) * page_size, max_messages)


def page_window(
    page: int, page_size: int, max_messages: int
) -> tuple[int, int]:
    """``--page`` and ``--page-size`` as upstream reads a page size of 0.

    Upstream (v2.2.1 ``envelope list``/``search``) filters a 0 page size
    out to none at all, which lists the whole mailbox whatever page was
    asked for; the whole mailbox here is the account's message window.

    Args:
        page (int): 1-based page number.
        page_size (int): maximum entries per page, 0 for no limit.
        max_messages (int): the account's message window.
    """
    if page_size == 0:
        return 1, max_messages
    return page, page_size


def page_slice(items: list[Any], page: int, page_size: int) -> list[Any]:
    """Take one page of results, counting from 1.

    Args:
        items (list): the ordered result set.
        page (int): 1-based page number.
        page_size (int): maximum entries per page.
    """
    start = max(page - 1, 0) * page_size
    return items[start : start + page_size]
