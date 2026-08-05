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

from datetime import datetime, timedelta, timezone

from dulwich.objects import Commit

SHORT_SHA = 7
INDENT = "    "
DAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct",
          "Nov", "Dec")


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
