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
from collections.abc import Sequence
from dataclasses import dataclass, replace
from typing import Protocol, cast

from dulwich.objects import Commit

from mirage.commands.cli.builtin.git.constants import TEMPLATE_KINDS
from mirage.commands.cli.builtin.git.dates import show_date
from mirage.commands.cli.builtin.git.errors import (
    BadPrettyError,
    UnsupportedPrettyError,
)
from mirage.commands.cli.builtin.git.mailmap import mapped_identity
from mirage.commands.cli.builtin.git.types import (
    DateKind,
    DateMode,
    Decoration,
    MailmapEntry,
)
from mirage.shell.bytes import byte_char, encode_text

SHORT_SHA = 7
FULL_SHA = 40
INDENT = "    "
DEFAULT_DATE = DateMode()
RAW_DATE = DateMode(kind=DateKind.RAW)

# The ident date placeholders that name a style of their own, whatever
# --date says: %ad alone follows it.
FIXED_DATE_KINDS = {
    "D": DateKind.RFC2822,
    "r": DateKind.RELATIVE,
    "t": DateKind.UNIX,
    "i": DateKind.ISO8601,
    "I": DateKind.ISO8601_STRICT,
    "h": DateKind.HUMAN,
    "s": DateKind.SHORT,
}

# The presets this build renders, and the real git presets it refuses
# by name rather than calling invalid.
PRESET_KINDS = ("oneline", "short", "medium", "full", "fuller", "raw")
UNSUPPORTED_PRESETS = ("email", "mboxrd", "reference")
HEX_DIGITS = "0123456789abcdefABCDEF"

Decorations = dict[bytes, list[str]]


@dataclass(frozen=True, slots=True)
class LogFormat:
    """The parsed value of ``--pretty``/``--format``.

    Args:
        kind (str): a preset name, or ``format``/``tformat`` for a
            placeholder template. ``format`` separates entries with a
            newline; ``tformat`` terminates each entry with one, and is
            what a bare ``%`` string means.
        template (str | None): the placeholder string, None for presets.
    """

    kind: str
    template: str | None = None


MEDIUM = LogFormat(kind="medium")


class CommitDisplay(Protocol):
    """What ``log`` and ``show`` both read off their flags to present a
    commit.

    Args:
        pretty (LogFormat): how the commit renders.
        abbrev_commit (bool): print an abbreviated id, which
            ``--oneline`` implies and ``--pretty=oneline`` alone does
            not.
        date (DateMode): how dates render.
        mailmap (tuple[MailmapEntry, ...]): the worktree ``.mailmap``.
        use_mailmap (bool): map the header identities.
        decorate (Decoration): how the commit is labelled with its refs.
    """

    @property
    def pretty(self) -> LogFormat: ...

    @property
    def abbrev_commit(self) -> bool: ...

    @property
    def date(self) -> DateMode: ...

    @property
    def mailmap(self) -> tuple[MailmapEntry, ...]: ...

    @property
    def use_mailmap(self) -> bool: ...

    @property
    def decorate(self) -> Decoration: ...


def parse_pretty(value: str) -> LogFormat:
    """Read a --pretty/--format value the way git reads it.

    Args:
        value (str): the flag's value as spelled.

    Raises:
        UnsupportedPrettyError: a real git preset this build lacks.
        BadPrettyError: a name git itself would refuse.
    """
    if value.startswith("format:"):
        return LogFormat(kind="format", template=value[len("format:") :])
    if value.startswith("tformat:"):
        return LogFormat(kind="tformat", template=value[len("tformat:") :])
    # A bare % string is tformat; so is the empty string, which renders
    # every commit as nothing and therefore prints nothing at all.
    if "%" in value or value == "":
        return LogFormat(kind="tformat", template=value)
    if value in PRESET_KINDS:
        return LogFormat(kind=value)
    if value in UNSUPPORTED_PRESETS:
        raise UnsupportedPrettyError(value)
    raise BadPrettyError(value)


def needs_decorations(fmt: LogFormat) -> bool:
    """Whether rendering this format has to know the refs.

    Only ``%d``/``%D`` read them; git turns decorations off for piped
    preset output, which is the only output mirage produces.

    Args:
        fmt (LogFormat): the parsed format.
    """
    if fmt.template is None:
        return False
    cursor = 0
    while True:
        cursor = fmt.template.find("%", cursor)
        if cursor == -1 or cursor + 1 == len(fmt.template):
            return False
        if fmt.template[cursor + 1] in ("d", "D"):
            return True
        cursor += 2


def abbrev_length(packed: int) -> int:
    """How many hex digits an abbreviated id needs in a repository.

    git widens the abbreviation as a repository grows, so ``--oneline``
    on a large repository prints nine characters where a fresh one
    prints seven, and a build that always printed seven disagreed with
    real git on every line of every big repository.

    Measured against git 2.50.1 rather than read off its source, and the
    boundary is sharp: 16,383 packed objects abbreviate to 7 and 16,384
    to 8, which is one hex digit per two bits of object count, floored
    at git's seven. Confirmed again at 20,102 (8), 70,102 (9) and
    184,401 (9).

    Only packed objects count. The same 70,102 objects abbreviate to 7
    while loose and to 9 once packed, which is consistent with it being
    an estimate: a pack index states its object count in its header,
    while counting loose objects means walking 256 directories.

    Args:
        packed (int): how many objects the repository's packs hold.
    """
    return max(SHORT_SHA, -(-packed.bit_length() // 2))


def short(sha: bytes, length: int = SHORT_SHA) -> str:
    """Abbreviate an object id the way ``--oneline`` prints it.

    Args:
        sha (bytes): hex object id.
        length (int): how many hex digits to keep, from abbrev_length.
    """
    return sha.decode()[:length]


def subject(commit: Commit) -> str:
    """The first paragraph of a commit message, folded onto one line.

    Args:
        commit (Commit): the commit to read.
    """
    text = commit.message.decode("utf-8", errors="replace")
    return _subject_folded(text)


def oneline(commit: Commit, length: int = SHORT_SHA) -> str:
    """One ``--oneline`` row: abbreviated id then subject.

    Args:
        commit (Commit): the commit to render.
        length (int): how many hex digits of the id to print.
    """
    return f"{short(commit.id, length)} {subject(commit)}"


def _trim_line(line: str) -> str:
    """Remove Git's trailing line whitespace in one backward pass.

    Args:
        line (str): one decoded message line, without its newline.
    """
    return line.rstrip(" \t\r")


def message_block(commit: Commit) -> list[str]:
    """A commit message indented the way log and show print it.

    Every line is indented by four spaces, blank lines included, so an
    empty line inside a message renders as four spaces rather than as an
    empty one. Verified against git 2.47.3; it is trailing whitespace on
    purpose.

    Args:
        commit (Commit): the commit to render.
    """
    text = commit.message.decode("utf-8", errors="replace")
    lines = [_trim_line(line) for line in text.split("\n")]
    start, end = 0, len(lines)
    while start < end and not lines[start]:
        start += 1
    while end > start and not lines[end - 1]:
        end -= 1
    return [INDENT + line for line in lines[start:end]]


def _merge_line(
    commit: Commit, length: int, parents: Sequence[bytes] | None = None
) -> list[str]:
    """The ``Merge:`` line every block preset prints for a merge, which
    git puts between the id and the author for both ``log`` and
    ``show``.

    Args:
        commit (Commit): the commit to render.
        length (int): how many hex digits of a parent id to print.
        parents (Sequence[bytes] | None): the parents to print, the
            commit's own when None.
    """
    shown = commit.parents if parents is None else parents
    if len(shown) <= 1:
        return []
    return [f"Merge: {' '.join(short(p, length) for p in shown)}"]


def preset_block(
    commit: Commit,
    kind: str,
    length: int,
    date: DateMode = DEFAULT_DATE,
    mailmap: tuple[MailmapEntry, ...] = (),
    parents: Sequence[bytes] | None = None,
) -> list[str]:
    """One commit as a block preset renders it (short/medium/full/fuller).

    Pinned against git 2.50: ``medium`` is the id, author, author date
    and indented message; ``short`` is the id, author and indented
    subject; ``full`` adds ``Commit:`` and drops both dates; ``fuller``
    aligns four header lines to the ``AuthorDate:`` column.

    Args:
        commit (Commit): the commit to render.
        kind (str): the preset name, already validated.
        length (int): how many hex digits of a parent id to print.
        parents (Sequence[bytes] | None): the parents to print, the
            commit's own when None; a path-limited log prints the ones
            it kept, though raw prints the stored ones whatever the
            graph draws (git 2.47.3).
    """
    if kind == "raw":
        return [
            f"commit {commit.id.decode()}",
            f"tree {commit.tree.decode()}",
            *[f"parent {p.decode()}" for p in commit.parents],
            f"author {commit.author.decode()} "
            + show_date(commit.author_time, commit.author_timezone, RAW_DATE),
            f"committer {commit.committer.decode()} "
            + show_date(commit.commit_time, commit.commit_timezone, RAW_DATE),
            "",
            *message_block(commit),
        ]
    author = mapped_identity(
        commit.author.decode("utf-8", errors="replace"), mailmap
    )
    committer = mapped_identity(
        commit.committer.decode("utf-8", errors="replace"), mailmap
    )
    lines = [
        f"commit {commit.id.decode()}",
        *_merge_line(commit, length, parents),
    ]
    if kind == "medium":
        lines.extend(
            [
                f"Author: {author}",
                "Date:   "
                + show_date(commit.author_time, commit.author_timezone, date),
                "",
                *message_block(commit),
            ]
        )
        return lines
    if kind == "short":
        message = commit.message.decode("utf-8", errors="replace")
        lines.extend(
            [
                f"Author: {author}",
                "",
                *[INDENT + line for line in _subject_lines(message)],
            ]
        )
        return lines
    if kind == "full":
        lines.extend(
            [
                f"Author: {author}",
                f"Commit: {committer}",
                "",
                *message_block(commit),
            ]
        )
        return lines
    lines.extend(
        [
            f"Author:     {author}",
            "AuthorDate: "
            + show_date(commit.author_time, commit.author_timezone, date),
            f"Commit:     {committer}",
            "CommitDate: "
            + show_date(commit.commit_time, commit.commit_timezone, date),
            "",
            *message_block(commit),
        ]
    )
    return lines


def ident_name(ident: bytes) -> str:
    """The name half of a ``Name <email>`` identity line.

    Args:
        ident (bytes): the stored author or committer line.
    """
    text = ident.decode("utf-8", errors="replace")
    marker = text.rfind(" <")
    return text[:marker] if marker != -1 else text


def ident_email(ident: bytes) -> str:
    """The email half of a ``Name <email>`` identity line.

    Args:
        ident (bytes): the stored author or committer line.
    """
    text = ident.decode("utf-8", errors="replace")
    start = text.rfind("<")
    end = text.rfind(">")
    return text[start + 1 : end] if 0 <= start < end else ""


def _subject_lines(message: str) -> list[str]:
    """The subject paragraph's lines, with Git's trailing whitespace removed.

    Args:
        message (str): the decoded commit message.
    """
    text = re.sub(r"^(?:[ \t\r]*\n)+", "", message)
    head = re.split(r"\n[ \t\r]*\n", text, maxsplit=1)[0]
    lines = [_trim_line(part) for part in head.split("\n")]
    return [line for line in lines if line]


def _subject_folded(message: str) -> str:
    """git's %s: the first paragraph folded onto one line.

    Args:
        message (str): the decoded commit message.
    """
    return " ".join(_subject_lines(message))


def _body(message: str) -> str:
    """git's %b: the text after the subject and blank separator lines.

    Args:
        message (str): the decoded commit message.
    """
    text = re.sub(r"^(?:[ \t\r]*\n)+", "", message)
    separator = re.search(r"\n(?:[ \t\r]*\n)+(?:[ \t\r]+$)?", text)
    return "" if separator is None else text[separator.end() :]


def render_template(
    template: str,
    commit: Commit,
    length: int,
    decor: Decorations | None,
    date: DateMode = DEFAULT_DATE,
    mailmap: tuple[MailmapEntry, ...] = (),
    parents: Sequence[bytes] | None = None,
) -> str:
    """Expand a format:/tformat: template for one commit.

    The scan matches git's behaviour pinned in docker: an
    unknown or incomplete placeholder stays verbatim (``%q`` prints
    ``%q``), ``%%`` is a literal percent, and ``%xHH`` names a raw
    output byte (``%x80`` is the single byte 0x80, carried by the
    shell's byte-escape convention until ``encode_text`` writes it).
    Explicit cursor, one pass, like the stat -c engine.

    Args:
        template (str): the placeholder string.
        commit (Commit): the commit to render.
        length (int): abbreviated id width for %h/%p/%t.
        decor (Decorations | None): ref labels for %d/%D.
        parents (Sequence[bytes] | None): the parents %p/%P print, the
            commit's own when None.
    """
    message = commit.message.decode("utf-8", errors="replace")
    labels = [] if decor is None else decor.get(commit.id, [])
    out: list[str] = []
    i = 0
    while i < len(template):
        char = template[i]
        if char != "%" or i + 1 == len(template):
            out.append(char)
            i += 1
            continue
        marker = template[i + 1]
        expanded = _simple_placeholder(
            marker, commit, message, length, labels, parents
        )
        if expanded is not None:
            out.append(expanded)
            i += 2
            continue
        if marker in ("a", "c") and i + 2 < len(template):
            pair = _ident_placeholder(
                marker, template[i + 2], commit, date, mailmap
            )
            if pair is not None:
                out.append(pair)
                i += 3
                continue
        if (
            marker == "x"
            and i + 3 < len(template)
            and template[i + 2] in HEX_DIGITS
            and template[i + 3] in HEX_DIGITS
        ):
            out.append(byte_char(int(template[i + 2 : i + 4], 16)))
            i += 4
            continue
        out.append(char + marker)
        i += 2
    return "".join(out)


def _simple_placeholder(
    marker: str,
    commit: Commit,
    message: str,
    length: int,
    labels: list[str],
    parents: Sequence[bytes] | None = None,
) -> str | None:
    """One single-letter placeholder's value, None when it is not one.

    Args:
        marker (str): the character after ``%``.
        commit (Commit): the commit to render.
        message (str): the decoded message.
        length (int): abbreviated id width.
        labels (list[str]): decoration labels for %d/%D.
        parents (Sequence[bytes] | None): the parents %p/%P print.
    """
    if marker == "H":
        return commit.id.decode()
    if marker == "h":
        return short(commit.id, length)
    if marker == "T":
        return cast(bytes, commit.tree).decode()
    if marker == "t":
        return short(commit.tree, length)
    shown = commit.parents if parents is None else parents
    if marker == "P":
        return " ".join(p.decode() for p in shown)
    if marker == "p":
        return " ".join(short(p, length) for p in shown)
    if marker == "s":
        return _subject_folded(message)
    if marker == "b":
        return _body(message)
    if marker == "B":
        return message
    if marker == "D":
        return ", ".join(labels)
    if marker == "d":
        return f" ({', '.join(labels)})" if labels else ""
    if marker == "n":
        return "\n"
    if marker == "%":
        return "%"
    return None


def _ident_placeholder(
    who: str,
    field: str,
    commit: Commit,
    date: DateMode,
    mailmap: tuple[MailmapEntry, ...],
) -> str | None:
    """An author/committer placeholder's value (%an, %cd, ...).

    Uppercase identity placeholders always apply the worktree mailmap.

    Args:
        who (str): ``a`` or ``c``.
        field (str): the letter after it.
        commit (Commit): the commit to render.
        date (DateMode): the ``--date`` style, which ``%ad`` follows and
            the fixed styles take their clock from.
        mailmap (tuple[MailmapEntry, ...]): the worktree mailmap.
    """
    ident = commit.author if who == "a" else commit.committer
    if field in ("N", "E"):
        ident = mapped_identity(
            ident.decode("utf-8", "replace"), mailmap
        ).encode()
    time = commit.author_time if who == "a" else commit.commit_time
    zone = commit.author_timezone if who == "a" else commit.commit_timezone
    if field in ("n", "N"):
        return ident_name(ident)
    if field in ("e", "E"):
        return ident_email(ident)
    if field == "d":
        return show_date(time, zone, date)
    if field in FIXED_DATE_KINDS:
        return show_date(
            time,
            zone,
            replace(
                date, kind=FIXED_DATE_KINDS[field], local=False, strftime=""
            ),
        )
    return None


def commit_header(
    commit: Commit,
    display: CommitDisplay,
    width: int,
    decor: Decorations | None,
    parents: Sequence[bytes] | None = None,
) -> bytes:
    """One commit's header, as ``log`` and ``show`` print it.

    ``format:`` is a separator, so a single commit prints with no
    trailing newline at all; ``tformat:`` terminates the entry even
    when it renders empty, except that an empty template prints
    nothing, which is how ``--format=`` stays silent. Bytes go out
    through ``encode_text`` because ``%xHH`` names a raw byte. Pinned
    against git 2.37 and 2.54. A decorated preset labels the commit
    after its id.

    Args:
        commit (Commit): the commit to render.
        display (CommitDisplay): the invocation's presentation flags.
        width (int): abbreviated id width for this repository.
        decor (Decorations | None): ref labels when the format asked.
        parents (Sequence[bytes] | None): the parents to print, the
            commit's own when None.
    """
    fmt = display.pretty
    decorated = display.decorate is not Decoration.NONE
    if fmt.kind == "oneline":
        length = width if display.abbrev_commit else FULL_SHA
        line = (
            render_template("%h%d %s", commit, length, decor)
            if decorated
            else oneline(commit, length)
        )
        return f"{line}\n".encode()
    if fmt.kind in TEMPLATE_KINDS:
        rendered = render_template(
            fmt.template or "",
            commit,
            width,
            decor,
            display.date,
            display.mailmap,
            parents,
        )
        if fmt.kind == "tformat":
            return encode_text(f"{rendered}\n") if fmt.template else b""
        return encode_text(rendered)
    block = preset_block(
        commit,
        fmt.kind,
        width,
        display.date,
        display.mailmap if display.use_mailmap else (),
        parents,
    )
    if decorated and block and block[0].startswith("commit "):
        block[0] += render_template("%d", commit, width, decor)
    return ("\n".join(block) + "\n").encode()
