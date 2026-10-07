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
from functools import cmp_to_key
from os.path import commonprefix

from mirage.commands.cli.builtin.git.errors import (
    FormatUsageError,
    GitError,
    UnparsableFormatError,
)
from mirage.commands.cli.builtin.git.ref_fields import field_value, parse_field
from mirage.commands.cli.builtin.git.types import (
    FieldCompare,
    FieldValue,
    FormatFrame,
    QuoteStyle,
    RefContext,
    RefField,
    RefFormat,
    RefItem,
    RefKind,
    RefSortKey,
)
from mirage.shell.bytes import byte_char
from mirage.utils.strverscmp import strverscmp
from mirage.utils.width import char_width

HEX = "0123456789abcdefABCDEF"
C_SPACE = " \t\n\v\f\r"
VERSION_PREFIXES = ("version:", "v:")
# The quote styles a bare %(raw) cannot be used with: raw content may
# hold a NUL, which only perl's quoting carries.
TEXT_QUOTES = (QuoteStyle.PYTHON, QuoteStyle.SHELL, QuoteStyle.TCL)
TCL_ESCAPES = {"\f": "\\f", "\r": "\\r", "\n": "\\n", "\t": "\\t", "\v": "\\v"}


def _next_field(template: str, start: int) -> int:
    """``find_next``: where the next ``%(`` starts, -1 for none; a
    ``%%`` is a quoted percent and never starts one.

    Args:
        template (str): the format.
        start (int): where to look from.
    """
    i = start
    while i < len(template):
        if template[i] == "%":
            if template.startswith("(", i + 1):
                return i
            if template.startswith("%", i + 1):
                i += 1
        i += 1
    return -1


def literal_text(text: str) -> str:
    """``append_literal``: ``%%`` is a percent and ``%xx`` the byte it
    names in hex; any other ``%`` stays.

    Args:
        text (str): literal text between fields.
    """
    out: list[str] = []
    i = 0
    while i < len(text):
        if text[i] == "%":
            if text.startswith("%", i + 1):
                out.append("%")
                i += 2
                continue
            pair = text[i + 1 : i + 3]
            if len(pair) == 2 and pair[0] in HEX and pair[1] in HEX:
                out.append(byte_char(int(pair, 16)))
                i += 3
                continue
        out.append(text[i])
        i += 1
    return "".join(out)


def parse_format(
    template: str, quote: QuoteStyle = QuoteStyle.NONE
) -> RefFormat:
    """Read a ``--format`` the way git's ``verify_ref_format`` does.

    Every field is parsed here, before any ref is read, so a bad one is
    refused by a listing that would print nothing.

    Args:
        template (str): the format as typed.
        quote (QuoteStyle): the quoting option, which bare ``%(raw)``
            refuses all but perl's of.

    Raises:
        FormatUsageError: a ``%(`` with no ``)``.
        GitError: a field git refuses, in its words.
    """
    pieces: list[str | RefField] = []
    cursor = 0
    while cursor < len(template):
        start = _next_field(template, cursor)
        if start == -1:
            break
        end = template.find(")", start)
        if end == -1:
            raise FormatUsageError(
                f"malformed format string {template[start:]}"
            )
        if start > cursor:
            pieces.append(literal_text(template[cursor:start]))
        name = template[start + 2 : end]
        field = parse_field(name)
        if field.field == "rest":
            raise GitError(f"this command reject atom %({name})")
        if (
            quote in TEXT_QUOTES
            and field.field == "raw"
            and field.option == "bare"
        ):
            raise GitError(
                f"--format={name} cannot be used with --python, --shell, --tcl"
            )
        pieces.append(field)
        cursor = end + 1
    if cursor < len(template):
        pieces.append(literal_text(template[cursor:]))
    return RefFormat(pieces=tuple(pieces), quote=quote)


def listing_format(template: str) -> RefFormat:
    """A ``branch`` or ``tag`` format, whose unclosed ``%(`` is refused
    as those verbs refuse it rather than with ``for-each-ref``'s usage.

    Args:
        template (str): the format as typed.
    """
    try:
        return parse_format(template)
    except FormatUsageError as exc:
        raise UnparsableFormatError(
            str(exc).removeprefix("malformed format string ")
        ) from exc


def parse_sort_keys(spellings: Sequence[str]) -> tuple[RefSortKey, ...]:
    """``ref_sorting_options``: the sort keys, the last one given first.

    Each key may start with ``-`` (reverse) and then ``version:`` or
    ``v:`` (compare as versions); what is left is a field.

    Args:
        spellings (Sequence[str]): the keys as given, in line order.
    """
    keys: list[RefSortKey] = []
    for spelling in spellings:
        reverse = spelling.startswith("-")
        rest = spelling[1:] if reverse else spelling
        prefix = next(
            (p for p in VERSION_PREFIXES if rest.startswith(p)), None
        )
        if prefix is not None:
            rest = rest[len(prefix) :]
        keys.append(
            RefSortKey(
                field=parse_field(rest),
                reverse=reverse,
                version=prefix is not None,
            )
        )
    return tuple(reversed(keys))


def used_fields(
    fmt: RefFormat, keys: Sequence[RefSortKey] = ()
) -> tuple[RefField, ...]:
    """Every distinct field a listing reads, format fields first.

    Args:
        fmt (RefFormat): the parsed format.
        keys (Sequence[RefSortKey]): the sort keys.
    """
    seen: dict[str, RefField] = {}
    for piece in fmt.pieces:
        if isinstance(piece, RefField):
            seen.setdefault(piece.name, piece)
    for key in keys:
        seen.setdefault(key.field.name, key.field)
    return tuple(seen.values())


def quote_text(text: str, style: QuoteStyle) -> str:
    """One value quoted the way ``quote_formatting`` does it.

    Args:
        text (str): the value.
        style (QuoteStyle): the quoting option.
    """
    if style is QuoteStyle.SHELL:
        return "'" + text.replace("'", "'\\''").replace("!", "'\\!'") + "'"
    if style is QuoteStyle.PERL:
        return "'" + text.replace("\\", "\\\\").replace("'", "\\'") + "'"
    if style is QuoteStyle.PYTHON:
        escaped = text.replace("\\", "\\\\").replace("'", "\\'")
        return "'" + escaped.replace("\n", "\\n") + "'"
    if style is QuoteStyle.TCL:
        out = []
        for char in text:
            if char in '[]{}$\\"':
                out.append("\\" + char)
            else:
                out.append(TCL_ESCAPES.get(char, char))
        return '"' + "".join(out) + '"'
    return text


class ValueTable:
    """Each listed ref's field values, filled all at once when first
    read, as git's ``populate_value`` fills them.

    Reading every field together is what makes an error one of them
    raises (a date style git lacks) surface on the first ref that has
    the field, whichever field was asked for.

    Args:
        fields (tuple[RefField, ...]): every field the listing reads.
        ctx (RefContext): the listing's facts.
    """

    def __init__(self, fields: tuple[RefField, ...], ctx: RefContext) -> None:
        self._fields = fields
        self._ctx = ctx
        self._rows: dict[str, dict[str, FieldValue]] = {}

    def value(self, item: RefItem, field: RefField) -> FieldValue:
        """One field's value for one ref.

        Args:
            item (RefItem): the ref.
            field (RefField): the field.
        """
        row = self._rows.get(item.name)
        if row is None:
            row = {
                f.name: field_value(f, item, self._ctx) for f in self._fields
            }
            self._rows[item.name] = row
        found = row.get(field.name)
        return (
            found if found is not None else field_value(field, item, self._ctx)
        )


def _swap_prereleases(
    a: str, b: str, off: int, suffixes: Sequence[str]
) -> int | None:
    """``swap_prereleases``: a ``versionsort.suffix`` around the first
    difference sorts its version before the one without it.

    Args:
        a (str): the first value.
        b (str): the second value.
        off (int): where they first differ.
        suffixes (Sequence[str]): ``versionsort.suffix``, in order.
    """
    found = [[-1, off, -1], [-1, off, -1]]
    for position, suffix in enumerate(suffixes):
        start = off - len(suffix) if len(suffix) < off else 0
        for text, match in ((a, found[0]), (b, found[1])):
            end = match[1] if match[2] < len(suffix) else match[1] - 1
            for i in range(start, end + 1):
                if text.startswith(suffix, i):
                    match[:] = [position, i, len(suffix)]
                    break
    first, second = found[0][0], found[1][0]
    if first == second:
        return None
    if first >= 0 and second >= 0:
        return first - second
    return -1 if first >= 0 else 1


def versioncmp(a: str, b: str, suffixes: Sequence[str] = ()) -> int:
    """git's ``versioncmp``: glibc's ``strverscmp``, unless a
    ``versionsort.suffix`` around the first difference decides.

    Args:
        a (str): the first value.
        b (str): the second value.
        suffixes (Sequence[str]): ``versionsort.suffix``.
    """
    if suffixes and a != b:
        off = len(commonprefix([a, b]))
        swapped = _swap_prereleases(a, b, off, suffixes)
        if swapped is not None:
            return swapped
    return strverscmp(a, b)


def _compare_text(a: str, b: str, icase: bool) -> int:
    """``strcmp``, or ``strcasecmp`` folding ASCII only.

    Args:
        a (str): the first value.
        b (str): the second value.
        icase (bool): ``--ignore-case``.
    """
    if icase:
        a, b = _ascii_lower(a), _ascii_lower(b)
    return (a > b) - (a < b)


def _ascii_lower(text: str) -> str:
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in text)


def sort_refs(
    items: Sequence[RefItem],
    keys: Sequence[RefSortKey],
    table: ValueTable,
    ctx: RefContext,
    icase: bool = False,
    detached_first: bool = False,
) -> list[RefItem]:
    """``ref_array_sort``: order refs by each key in turn, then by name.

    The name that breaks a tie is never reversed, so ``-committerdate``
    lists refs of one date in name order. ``branch`` puts a detached
    HEAD first whatever the keys say.

    Args:
        items (Sequence[RefItem]): the refs.
        keys (Sequence[RefSortKey]): the keys, primary first.
        table (ValueTable): their values.
        ctx (RefContext): carries ``versionsort.suffix``.
        icase (bool): ``--ignore-case``.
        detached_first (bool): whether a detached HEAD leads.
    """

    def by_key(key: RefSortKey, a: RefItem, b: RefItem) -> int:
        va, vb = table.value(a, key.field), table.value(b, key.field)
        if detached_first and RefKind.DETACHED in (a.kind, b.kind):
            return -1 if a.kind is RefKind.DETACHED else 1
        if key.version:
            cmp = versioncmp(va.text, vb.text, ctx.suffixes)
        elif key.field.compare is FieldCompare.TEXT:
            cmp = _compare_text(va.text, vb.text, icase)
        else:
            cmp = (va.number > vb.number) - (va.number < vb.number)
        return -cmp if key.reverse else cmp

    def compare(a: RefItem, b: RefItem) -> int:
        for key in keys:
            cmp = by_key(key, a, b)
            if cmp:
                return cmp
        return _compare_text(a.name, b.name, icase and bool(keys))

    return sorted(items, key=cmp_to_key(compare))


def display_width(text: str) -> int:
    """A text's display width, as ``utf8_strwidth`` counts it.

    Args:
        text (str): the text.
    """
    return sum(max(char_width(char), 0) for char in text)


def _aligned(text: str, field: RefField) -> str:
    """``strbuf_utf8_align``: pad a block to a display width.

    Args:
        text (str): the block.
        field (RefField): the ``align`` field, width and position.
    """
    pad = field.number - display_width(text)
    if pad <= 0:
        return text
    if field.text == "left":
        return text + " " * pad
    if field.text == "right":
        return " " * pad + text
    return " " * (pad // 2) + text + " " * (pad - pad // 2)


def _satisfied(frame: FormatFrame, text: str) -> bool:
    """Whether an ``%(if)`` holds for what it read before its ``then``.

    Args:
        frame (FormatFrame): the ``if`` frame.
        text (str): what was rendered between ``%(if)`` and
            ``%(then)``.
    """
    field = frame.opener
    assert field is not None
    if field.option == "equals":
        return text == field.text
    if field.option == "notequals":
        return text != field.text
    return bool(text.strip(C_SPACE))


def _end(stack: list[FormatFrame], quote: QuoteStyle) -> None:
    """``end_atom_handler``: close the innermost ``align`` or ``if``.

    Args:
        stack (list[FormatFrame]): the open blocks, root first.
        quote (QuoteStyle): quotes the block if it is outermost.
    """
    current = stack[-1]
    if current.kind == "root":
        raise GitError("format: %(end) atom used without corresponding atom")
    if current.kind == "align":
        assert current.opener is not None
        current.out = [_aligned("".join(current.out), current.opener)]
    else:
        head = current.head or current
        if not head.then_seen:
            raise GitError("format: %(if) atom used without a %(then) atom")
        if current.head is not None:
            branch = current
            stack.pop()
            current = stack[-1]
            if not head.satisfied:
                current.out = branch.out
        elif not head.satisfied:
            current.out = []
    block = "".join(current.out)
    stack.pop()
    stack[-1].out.append(
        quote_text(block, quote) if len(stack) == 1 else block
    )


def render_ref(fmt: RefFormat, item: RefItem, table: ValueTable) -> str:
    """``format_ref_array_item``: one ref through the format.

    A field's value is quoted unless it sits inside an ``align`` or
    ``if`` block, where the whole outermost block is quoted at its
    ``%(end)`` instead; literal text is never quoted.

    Args:
        fmt (RefFormat): the parsed format.
        item (RefItem): the ref.
        table (ValueTable): the listing's values.

    Raises:
        GitError: blocks that do not nest, in git's words.
    """
    stack = [FormatFrame(kind="root")]
    for piece in fmt.pieces:
        if isinstance(piece, str):
            stack[-1].out.append(piece)
            continue
        value = table.value(item, piece)
        head = piece.field
        if head == "align":
            stack.append(FormatFrame(kind="align", opener=piece))
        elif head == "if":
            stack.append(FormatFrame(kind="if", opener=piece))
        elif head == "then":
            frame = stack[-1]
            if frame.kind != "if":
                raise GitError(
                    "format: %(then) atom used without a %(if) atom"
                )
            if (frame.head or frame).then_seen:
                raise GitError("format: %(then) atom used more than once")
            frame.then_seen = True
            frame.satisfied = _satisfied(frame, "".join(frame.out))
            frame.out = []
        elif head == "else":
            frame = stack[-1]
            if frame.kind != "if":
                raise GitError(
                    "format: %(else) atom used without a %(if) atom"
                )
            owner = frame.head or frame
            if not owner.then_seen:
                raise GitError(
                    "format: %(else) atom used without a %(then) atom"
                )
            if frame.head is not None:
                raise GitError("format: %(else) atom used more than once")
            stack.append(
                FormatFrame(kind="if", opener=frame.opener, head=frame)
            )
        elif head == "end":
            _end(stack, fmt.quote)
        elif len(stack) == 1:
            stack[-1].out.append(quote_text(value.text, fmt.quote))
        else:
            stack[-1].out.append(value.text)
    if len(stack) > 1:
        raise GitError("format: %(end) atom missing")
    return "".join(stack[0].out)


def format_refs(
    fmt: RefFormat,
    items: Sequence[RefItem],
    ctx: RefContext,
    keys: Sequence[RefSortKey] | None,
    count: int = 0,
    omit_empty: bool = False,
    icase: bool = False,
    detached_first: bool = False,
    stream: bool = True,
) -> tuple[str, GitError | None]:
    """``filter_and_format_refs``: sort the refs, then print each one.

    A listing sorted by name alone is printed ref by ref, as git streams
    it, so a field that fails on a later ref (a date style git lacks,
    read only off a commit) fails after the refs before it printed; any
    other listing reads every ref while sorting, before it prints one.

    Args:
        fmt (RefFormat): the parsed format.
        items (Sequence[RefItem]): the refs, in name order.
        ctx (RefContext): the listing's facts.
        keys (Sequence[RefSortKey] | None): the sort keys, primary
            first; None for ``--no-sort``.
        count (int): ``--count``, zero for every ref.
        omit_empty (bool): ``--omit-empty``: an empty row prints no
            newline.
        icase (bool): ``--ignore-case``.
        detached_first (bool): whether a detached HEAD leads.
        stream (bool): whether a listing sorted by name alone may be
            printed ref by ref; ``--merged`` and ``branch`` never are.

    Returns:
        tuple[str, GitError | None]: what was printed, and the error the
        listing stopped at.
    """
    table = ValueTable(used_fields(fmt, keys or ()), ctx)
    rows: list[str] = []
    try:
        ordered = list(items)
        # Git 2.50.1's can_do_iterative_format checks the atom type, even
        # for :short/:lstrip after --no-sort removes the default tie-breaker.
        by_name = keys is None or (
            len(keys) == 1
            and not keys[0].reverse
            and not keys[0].version
            and not icase
            and keys[0].field.field == "refname"
        )
        if not (stream and by_name) and keys:
            ordered = sort_refs(
                ordered, keys, table, ctx, icase, detached_first
            )
        for item in ordered[:count] if count else ordered:
            row = render_ref(fmt, item, table)
            if row or not omit_empty:
                rows.append(row + "\n")
    except GitError as exc:
        return "".join(rows), exc
    return "".join(rows), None
