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
from datetime import date, timedelta
from email.utils import parsedate_to_datetime
from typing import Any, Callable

from mirage.types import JsonValue

# himalaya's search DSL: 3 operators (and, or, not) and 8 conditions
# (date, before, after, from, to, subject, body, flag), optionally
# followed by `order by <kind> [asc|desc]` sorters. Date conditions
# anchor on the `Date:` header, never on the server's received-at
# timestamp, which is why they emit SENTON/SENTBEFORE/SENTSINCE rather
# than ON/BEFORE/SINCE: imported or delayed mail would otherwise land on
# the wrong day.
CONDITIONS = ("date", "before", "after", "from", "to", "subject", "body",
              "flag")
SORT_KINDS = ("date", "from", "to", "subject")
FLAGS = {
    "seen": "SEEN",
    "answered": "ANSWERED",
    "flagged": "FLAGGED",
    "draft": "DRAFT",
    "deleted": "DELETED",
}
IMAP_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep",
               "Oct", "Nov", "Dec")


class QueryError(ValueError):
    """The query does not parse."""


@dataclass(frozen=True, slots=True)
class Token:
    text: str
    quoted: bool


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


def tokenize(source: str) -> list[Token]:
    """Split a query string into words, parens and quoted patterns.

    Mirrors upstream, which joins argv with spaces and parses the
    resulting character stream: a pattern containing spaces must carry
    literal double quotes, since the shell's own quotes are gone by the
    time the query arrives.

    Args:
        source (str): the joined query text.

    Raises:
        QueryError: the source ends inside a quoted pattern.
    """
    tokens: list[Token] = []
    index = 0
    while index < len(source):
        char = source[index]
        if char.isspace():
            index += 1
            continue
        if char in "()":
            tokens.append(Token(char, False))
            index += 1
            continue
        if char == '"':
            index += 1
            chars: list[str] = []
            while index < len(source) and source[index] != '"':
                if source[index] == "\\" and index + 1 < len(source):
                    index += 1
                chars.append(source[index])
                index += 1
            if index >= len(source):
                raise QueryError("unterminated quoted pattern")
            index += 1
            tokens.append(Token("".join(chars), True))
            continue
        start = index
        while index < len(source) and not source[index].isspace(
        ) and source[index] not in "()":
            index += 1
        tokens.append(Token(source[start:index], False))
    return tokens


def _keyword(token: Token | None) -> str | None:
    if token is None or token.quoted:
        return None
    return token.text.lower()


def _quote(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _imap_date(text: str) -> date:
    parts = text.split("-")
    if len(parts) != 3:
        raise QueryError(f"invalid date {text!r}, expected yyyy-mm-dd")
    try:
        return date(int(parts[0]), int(parts[1]), int(parts[2]))
    except ValueError as exc:
        raise QueryError(f"invalid date {text!r}: {exc}")


def _format_date(value: date) -> str:
    return f"{value.day:02d}-{IMAP_MONTHS[value.month - 1]}-{value.year}"


class _Parser:
    """Recursive-descent parser producing IMAP SEARCH keys directly.

    The AST would be a himalaya type, and translating it to IMAP is the
    only thing anything ever does with it, so the parser emits the
    criteria string as it goes.
    """

    def __init__(self, tokens: list[Token]) -> None:
        self.tokens = tokens
        self.index = 0

    def peek(self) -> Token | None:
        return self.tokens[self.index] if self.index < len(
            self.tokens) else None

    def take(self) -> Token:
        token = self.peek()
        if token is None:
            raise QueryError("unexpected end of query")
        self.index += 1
        return token

    def parse_filter(self) -> str:
        node = self.parse_or()
        return node

    def parse_or(self) -> str:
        left = self.parse_and()
        while _keyword(self.peek()) == "or":
            self.take()
            right = self.parse_and()
            left = f"OR {left} {right}"
        return left

    def parse_and(self) -> str:
        left = self.parse_unary()
        while _keyword(self.peek()) == "and":
            self.take()
            right = self.parse_unary()
            left = f"({left} {right})"
        return left

    def parse_unary(self) -> str:
        word = _keyword(self.peek())
        if word == "not":
            self.take()
            return f"NOT {self.parse_unary()}"
        if word == "(":
            self.take()
            inner = self.parse_or()
            if _keyword(self.peek()) != ")":
                raise QueryError("missing closing ')'")
            self.take()
            return inner
        return self.parse_condition()

    def parse_condition(self) -> str:
        token = self.take()
        word = _keyword(token)
        if word is None or word not in CONDITIONS:
            raise QueryError(f"expected a condition ({', '.join(CONDITIONS)}) "
                             f"but found {token.text!r}")
        value = self.take().text
        if word == "date":
            return f"SENTON {_format_date(_imap_date(value))}"
        if word == "before":
            return f"SENTBEFORE {_format_date(_imap_date(value))}"
        if word == "after":
            # Strictly greater than the given day; IMAP SENTSINCE is
            # inclusive, so ask for the day after.
            after = _imap_date(value) + timedelta(days=1)
            return f"SENTSINCE {_format_date(after)}"
        if word == "flag":
            key = FLAGS.get(value.lower())
            if key is None:
                raise QueryError(f"unknown flag {value!r}, expected one of "
                                 f"{', '.join(sorted(FLAGS))}")
            return key
        return f"{word.upper()} {_quote(value)}"

    def parse_sorters(self) -> tuple[Sorter, ...]:
        self.take()
        if _keyword(self.peek()) != "by":
            raise QueryError("expected 'by' after 'order'")
        self.take()
        sorters: list[Sorter] = []
        while True:
            kind = _keyword(self.peek())
            if kind not in SORT_KINDS:
                break
            self.take()
            descending = False
            order = _keyword(self.peek())
            if order in ("asc", "desc"):
                self.take()
                descending = order == "desc"
            sorters.append(Sorter(kind, descending))
        if not sorters:
            raise QueryError(f"expected a sort key "
                             f"({', '.join(SORT_KINDS)}) after 'order by'")
        return tuple(sorters)


def parse_query(source: str) -> Query:
    """Parse a himalaya search query into IMAP criteria plus sorters.

    Args:
        source (str): the query as typed, tokens already joined by space.

    Raises:
        QueryError: the query does not parse.
    """
    tokens = tokenize(source)
    parser = _Parser(tokens)
    criteria = "ALL"
    if _keyword(parser.peek()) not in (None, "order"):
        criteria = parser.parse_filter()
    sorters: tuple[Sorter, ...] = ()
    if _keyword(parser.peek()) == "order":
        sorters = parser.parse_sorters()
    leftover = parser.peek()
    if leftover is not None:
        raise QueryError(f"unexpected {leftover.text!r} at end of query")
    return Query(criteria=criteria, sorters=sorters)


def _sent_at(header: dict[str, Any]) -> float:
    try:
        return parsedate_to_datetime(header.get("date", "")).timestamp()
    except (TypeError, ValueError):
        return 0.0


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


def sort_headers(headers: list[dict[str, Any]],
                 sorters: tuple[Sorter, ...]) -> list[dict[str, Any]]:
    """Order fetched headers by the query's sorters.

    Applied client-side and right to left, so the first sorter ends up
    the primary key (Python's sort is stable). With no sorters the
    order is date descending, matching `envelope list`.

    Args:
        headers (list[dict]): envelope headers as fetched.
        sorters (tuple[Sorter, ...]): sorters in declaration order.
    """
    ordered = list(headers)
    if not sorters:
        ordered.sort(key=_sent_at, reverse=True)
        return ordered
    for sorter in reversed(sorters):
        ordered.sort(key=SORT_KEYS[sorter.kind], reverse=sorter.descending)
    return ordered


def uid_budget(page: int, page_size: int, sorters: tuple[Sorter, ...],
               max_messages: int) -> int:
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


def page_slice(items: list[Any], page: int, page_size: int) -> list[Any]:
    """Take one page of results, counting from 1.

    Args:
        items (list): the ordered result set.
        page (int): 1-based page number.
        page_size (int): maximum entries per page.
    """
    start = max(page - 1, 0) * page_size
    return items[start:start + page_size]
