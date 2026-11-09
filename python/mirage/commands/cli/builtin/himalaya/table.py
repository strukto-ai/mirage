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

from mirage.commands.cli.builtin.git.ref_format import display_width

INDICATOR = "…"
MIN_FREE_CHARS = 2
PADDING = 2
SIZE_UNITS = ("B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB")
KIBI = 1024.0


@dataclass(frozen=True, slots=True)
class Cell:
    """One table cell.

    Args:
        text (str): the cell's content.
        right (bool): align to the right of its column.
    """

    text: str
    right: bool = False


@dataclass(frozen=True, slots=True)
class Row:
    """One table row.

    Args:
        cells (tuple[Cell, ...]): the row's cells.
        max_height (int | None): lines the row may take before it is cut.
    """

    cells: tuple[Cell, ...]
    max_height: int | None = 1


def format_size(size: int) -> str:
    """A byte count in binary units, as the SIZE columns show it.

    Args:
        size (int): the number of bytes.
    """
    value = float(size)
    scale = 0
    while abs(value) >= KIBI:
        value /= KIBI
        scale += 1
    places = 0 if value == int(value) else 2
    return f"{value:.{places}f} {SIZE_UNITS[scale]}"


def _split_long_word(allowed: int, word: str) -> tuple[str, str]:
    taken = 0
    for index, char in enumerate(word):
        taken += display_width(char)
        if taken > allowed:
            return word[:index], word[index:]
    return word, ""


def _flushed(
    lines: list[str], width: int, line: str, length: int
) -> tuple[str, int]:
    if length > max(width - MIN_FREE_CHARS, 0):
        lines.append(line)
        return "", 0
    return line, length


def split_line(line: str, width: int) -> list[str]:
    """Wrap one line of a cell to the column's content width.

    Args:
        line (str): the line.
        width (int): the content width.
    """
    lines: list[str] = []
    words = line.split(" ")
    words.reverse()
    current = ""
    length = 0
    while words:
        word = words.pop()
        word_length = display_width(word)
        added = word_length + length + (1 if current else 0)
        remaining = width - length
        if current:
            remaining = max(remaining - 1, 0)
        if added <= width:
            if current:
                current += " "
                length += 1
            current += word
            length += word_length
            current, length = _flushed(lines, width, current, length)
            continue
        if current and remaining <= MIN_FREE_CHARS:
            words.append(word)
            lines.append(current)
            current = ""
            length = 0
            continue
        if word_length > width:
            fresh = not current
            if not fresh:
                current += " "
            head, tail = _split_long_word(remaining, word)
            if fresh and not head:
                current += tail[0]
                words.append(tail[1:])
            else:
                current += head
                words.append(tail)
            lines.append(current)
            current = ""
            length = 0
            continue
        lines.append(current)
        current = word
        length = word_length
        current, length = _flushed(lines, width, current, length)
    if current:
        lines.append(current)
    return lines


def _content_lines(cell: Cell) -> list[str]:
    return cell.text.split("\n")


def _longest_after_split(average: int, column: int, rows: list[Row]) -> int:
    longest = 0
    for row in rows:
        if column >= len(row.cells):
            continue
        for line in _content_lines(row.cells[column]):
            if display_width(line) > average:
                for part in split_line(line, average):
                    longest = max(longest, display_width(part))
            else:
                longest = max(longest, display_width(line))
    return longest


def arranged_widths(
    rows: list[Row], fitted: frozenset[int], max_width: int | None
) -> list[int]:
    """The content width of every column.

    Args:
        rows (list[Row]): the header row, then the body.
        fitted (frozenset[int]): columns that keep their full width.
        max_width (int | None): the width to squeeze the table into.
    """
    count = len(rows[0].cells)
    natural = [
        max(
            (
                max(map(display_width, _content_lines(row.cells[column])))
                for row in rows
                if column < len(row.cells)
            ),
            default=0,
        )
        for column in range(count)
    ]
    if max_width is None:
        return natural
    decided: dict[int, int] = {column: natural[column] for column in fitted}
    remaining_width = max(max_width - (count + 1), 0)
    for column in range(count):
        taken = decided[column] + PADDING if column in decided else PADDING
        remaining_width = max(remaining_width - taken, 0)
    remaining_columns = count - len(decided)

    def fix(column: int, width: int) -> None:
        nonlocal remaining_width, remaining_columns
        decided[column] = width
        remaining_width = max(remaining_width - width, 0)
        remaining_columns -= 1

    found = True
    while found and remaining_columns > 0:
        found = False
        if remaining_width // remaining_columns == 0:
            break
        for column in range(count):
            if column in decided:
                continue
            if natural[column] <= remaining_width // remaining_columns:
                fix(column, natural[column])
                found = True
                if remaining_columns == 0:
                    break
    found = remaining_columns > 0
    while found and remaining_columns > 0:
        found = False
        for column in range(count):
            if column in decided or remaining_columns == 0:
                continue
            average = remaining_width // remaining_columns
            longest = _longest_after_split(average, column, rows)
            if max(average - longest, 0) >= 3:
                fix(column, longest)
                found = True
    if remaining_columns == 0:
        return [decided[column] for column in range(count)]
    remaining_width = max(remaining_width, remaining_columns)
    average = remaining_width // remaining_columns
    excess = remaining_width - average * remaining_columns
    for column in range(count):
        if column in decided:
            continue
        decided[column] = average + (1 if excess > 0 else 0)
        excess -= 1
    return [decided[column] for column in range(count)]


def _truncated(line: str, width: int) -> str:
    indicator = "" if display_width(INDICATOR) > width else INDICATOR
    length = display_width(indicator)
    cut = 0
    fits = False
    for index, char in enumerate(line):
        cut = index
        wider = length + display_width(char)
        if wider > width:
            break
        length = wider
        if index == len(line) - 1:
            fits = True
    return (line if fits else line[:cut]) + indicator


def _cell_lines(cell: Cell, width: int, max_height: int | None) -> list[str]:
    lines: list[str] = []
    for line in _content_lines(cell):
        if display_width(line) > width:
            lines.extend(split_line(line, width))
        else:
            lines.append(line)
    if max_height is not None and len(lines) > max_height:
        del lines[max_height:]
        lines[-1] = _truncated(lines[-1], width)
    padded = []
    for line in lines:
        gap = " " * max(width - display_width(line), 0)
        padded.append(f" {gap}{line} " if cell.right else f" {line}{gap} ")
    return padded


def _render_row(row: Row, widths: list[int]) -> list[str]:
    columns = [
        _cell_lines(cell, width, row.max_height)
        for cell, width in zip(row.cells, widths, strict=True)
    ]
    height = max(map(len, columns), default=0)
    out: list[str] = []
    for index in range(height):
        fields = [
            lines[index] if index < len(lines) else " " * (width + PADDING)
            for lines, width in zip(columns, widths, strict=True)
        ]
        out.append("│" + "┆".join(fields) + "│")
    return out


def render_table(
    header: Row,
    rows: list[Row],
    max_width: int | None = None,
    fitted: frozenset[int] = frozenset(),
) -> str:
    """A table in the condensed box style, without a trailing newline.

    Args:
        header (Row): the header row.
        rows (list[Row]): the body.
        max_width (int | None): the width to squeeze the table into.
        fitted (frozenset[int]): columns that keep their full width.
    """
    widths = arranged_widths([header, *rows], fitted, max_width)
    rules = ["─" * (width + PADDING) for width in widths]
    thick = ["═" * (width + PADDING) for width in widths]
    lines = ["┌" + "┬".join(rules) + "┐"]
    lines += _render_row(header, widths)
    lines.append("╞" + "╪".join(thick) + "╡")
    for row in rows:
        lines += _render_row(row, widths)
    lines.append("└" + "┴".join(rules) + "┘")
    return "\n".join(lines)
