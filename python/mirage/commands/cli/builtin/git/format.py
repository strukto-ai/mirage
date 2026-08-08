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
from datetime import datetime, timedelta, timezone

from dulwich.objects import Commit

from mirage.commands.cli.builtin.git.errors import (BadPrettyError,
                                                    UnsupportedPrettyError)
from mirage.shell.bytes import byte_char

SHORT_SHA = 7
FULL_SHA = 40
INDENT = "    "
DAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct",
          "Nov", "Dec")

# The presets this build renders, and the real git presets it refuses
# by name rather than calling invalid.
PRESET_KINDS = ("oneline", "short", "medium", "full", "fuller")
UNSUPPORTED_PRESETS = ("raw", "email", "mboxrd", "reference")
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


def parse_pretty(value: str) -> LogFormat:
    """Read a --pretty/--format value the way git's pretty.c does.

    Args:
        value (str): the flag's value as spelled.

    Raises:
        UnsupportedPrettyError: a real git preset this build lacks.
        BadPrettyError: a name git itself would refuse.
    """
    if value.startswith("format:"):
        return LogFormat(kind="format", template=value[len("format:"):])
    if value.startswith("tformat:"):
        return LogFormat(kind="tformat", template=value[len("tformat:"):])
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


def git_date(timestamp: int, offset: int) -> str:
    """Render a commit time in git's default date format.

    ``Fri Jan 16 11:30:00 2026 +0000``: the day of the month is not
    padded, which is why this is built by hand rather than with strftime
    (``%d`` zero-pads and ``%-d`` is not portable). The stored offset is
    seconds east of UTC, and the timestamp is read in that offset, so a
    commit prints the wall clock its author saw.

    Args:
        timestamp (int): seconds since the epoch.
        offset (int): the author's UTC offset in seconds.
    """
    tz = timezone(timedelta(seconds=offset))
    moment = datetime.fromtimestamp(timestamp, tz)
    sign = "+" if offset >= 0 else "-"
    hours, minutes = divmod(abs(offset) // 60, 60)
    return (f"{DAYS[moment.weekday()]} {MONTHS[moment.month - 1]} "
            f"{moment.day} {moment:%H:%M:%S} {moment.year} "
            f"{sign}{hours:02d}{minutes:02d}")


def subject(commit: Commit) -> str:
    """The first line of a commit message.

    Args:
        commit (Commit): the commit to read.
    """
    text = commit.message.decode("utf-8", errors="replace")
    return text.split("\n", 1)[0].rstrip()


def oneline(commit: Commit, length: int = SHORT_SHA) -> str:
    """One ``--oneline`` row: abbreviated id then subject.

    Args:
        commit (Commit): the commit to render.
        length (int): how many hex digits of the id to print.
    """
    return f"{short(commit.id, length)} {subject(commit)}"


def message_block(commit: Commit) -> list[str]:
    """A commit message indented the way log and show print it.

    Every line is indented by four spaces, blank lines included, so an
    empty line inside a message renders as four spaces rather than as an
    empty one. Verified against git 2.47.3; it is trailing whitespace on
    purpose.

    Args:
        commit (Commit): the commit to render.
    """
    text = commit.message.decode("utf-8", errors="replace").rstrip("\n")
    return [f"{INDENT}{line}" for line in text.split("\n")]


def entry(commit: Commit, length: int = SHORT_SHA) -> list[str]:
    """A full log entry: the header block and the indented message.

    A merge carries an extra ``Merge:`` line naming its parents in
    abbreviated form, which git prints between the id and the author for
    both ``log`` and ``show``.

    Args:
        commit (Commit): the commit to render.
        length (int): how many hex digits of a parent id to print.
    """
    lines = [f"commit {commit.id.decode()}"]
    if len(commit.parents) > 1:
        lines.append(f"Merge: "
                     f"{' '.join(short(p, length) for p in commit.parents)}")
    lines.extend([
        f"Author: {commit.author.decode('utf-8', errors='replace')}",
        f"Date:   {git_date(commit.author_time, commit.author_timezone)}",
        "",
        *message_block(commit),
    ])
    return lines


def _merge_line(commit: Commit, length: int) -> list[str]:
    """The ``Merge:`` line every block preset prints for a merge.

    Args:
        commit (Commit): the commit to render.
        length (int): how many hex digits of a parent id to print.
    """
    if len(commit.parents) <= 1:
        return []
    return [f"Merge: {' '.join(short(p, length) for p in commit.parents)}"]


def _subject_only_block(commit: Commit) -> list[str]:
    """The subject indented the way ``--pretty=short`` prints it.

    Args:
        commit (Commit): the commit to render.
    """
    return [f"{INDENT}{subject(commit)}"]


def preset_block(commit: Commit, kind: str, length: int) -> list[str]:
    """One commit as a block preset renders it (short/medium/full/fuller).

    Pinned against git 2.50: ``short`` is the id, author and indented
    subject; ``full`` adds ``Commit:`` and drops both dates; ``fuller``
    aligns four header lines to the ``AuthorDate:`` column.

    Args:
        commit (Commit): the commit to render.
        kind (str): the preset name, already validated.
        length (int): how many hex digits of a parent id to print.
    """
    if kind == "medium":
        return entry(commit, length)
    author = commit.author.decode("utf-8", errors="replace")
    committer = commit.committer.decode("utf-8", errors="replace")
    lines = [f"commit {commit.id.decode()}", *_merge_line(commit, length)]
    if kind == "short":
        lines.extend([f"Author: {author}", "", *_subject_only_block(commit)])
        return lines
    if kind == "full":
        lines.extend([
            f"Author: {author}",
            f"Commit: {committer}",
            "",
            *message_block(commit),
        ])
        return lines
    lines.extend([
        f"Author:     {author}",
        f"AuthorDate: {git_date(commit.author_time, commit.author_timezone)}",
        f"Commit:     {committer}",
        f"CommitDate: {git_date(commit.commit_time, commit.commit_timezone)}",
        "",
        *message_block(commit),
    ])
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
    return text[start + 1:end] if 0 <= start < end else ""


def _subject_folded(message: str) -> str:
    """git's %s: the first paragraph folded onto one line.

    Args:
        message (str): the decoded commit message.
    """
    head = message.split("\n\n", 1)[0]
    return " ".join(part for part in head.split("\n") if part).strip()


def _body(message: str) -> str:
    """git's %b: everything after the subject paragraph.

    Args:
        message (str): the decoded commit message.
    """
    _, separator, rest = message.partition("\n\n")
    return rest if separator else ""


def decoration_names(decor: Decorations | None, commit: Commit) -> list[str]:
    """The decoration labels attached to one commit, or none.

    Args:
        decor (Decorations | None): sha-keyed labels, None when the
            format never asked for them.
        commit (Commit): the commit being rendered.
    """
    if decor is None:
        return []
    return decor.get(commit.id, [])


def render_template(template: str, commit: Commit, length: int,
                    decor: Decorations | None) -> str:
    """Expand a format:/tformat: template for one commit.

    The scan mirrors git's pretty.c behavior pinned in docker: an
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
    """
    message = commit.message.decode("utf-8", errors="replace")
    labels = decoration_names(decor, commit)
    out: list[str] = []
    i = 0
    while i < len(template):
        char = template[i]
        if char != "%" or i + 1 == len(template):
            out.append(char)
            i += 1
            continue
        marker = template[i + 1]
        expanded = _simple_placeholder(marker, commit, message, length, labels)
        if expanded is not None:
            out.append(expanded)
            i += 2
            continue
        if marker in ("a", "c") and i + 2 < len(template):
            pair = _ident_placeholder(marker, template[i + 2], commit)
            if pair is not None:
                out.append(pair)
                i += 3
                continue
        if marker == "x" and i + 3 < len(template) \
                and template[i + 2] in HEX_DIGITS \
                and template[i + 3] in HEX_DIGITS:
            out.append(byte_char(int(template[i + 2:i + 4], 16)))
            i += 4
            continue
        out.append(char + marker)
        i += 2
    return "".join(out)


def _simple_placeholder(marker: str, commit: Commit, message: str, length: int,
                        labels: list[str]) -> str | None:
    """One single-letter placeholder's value, None when it is not one.

    Args:
        marker (str): the character after ``%``.
        commit (Commit): the commit to render.
        message (str): the decoded message.
        length (int): abbreviated id width.
        labels (list[str]): decoration labels for %d/%D.
    """
    if marker == "H":
        return commit.id.decode()
    if marker == "h":
        return short(commit.id, length)
    if marker == "T":
        return commit.tree.decode()
    if marker == "t":
        return short(commit.tree, length)
    if marker == "P":
        return " ".join(p.decode() for p in commit.parents)
    if marker == "p":
        return " ".join(short(p, length) for p in commit.parents)
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


def _ident_placeholder(who: str, field: str, commit: Commit) -> str | None:
    """An author/committer placeholder's value (%an, %cd, ...).

    %aN/%aE are the mailmap variants; no mailmap is ever loaded, so
    they read as their plain forms.

    Args:
        who (str): ``a`` or ``c``.
        field (str): the letter after it.
        commit (Commit): the commit to render.
    """
    ident = commit.author if who == "a" else commit.committer
    time = commit.author_time if who == "a" else commit.commit_time
    zone = commit.author_timezone if who == "a" else commit.commit_timezone
    if field in ("n", "N"):
        return ident_name(ident)
    if field in ("e", "E"):
        return ident_email(ident)
    if field == "d":
        return git_date(time, zone)
    if field == "t":
        return str(time)
    return None
