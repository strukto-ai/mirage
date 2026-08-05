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

from dulwich.objects import Commit
from dulwich.repo import BaseRepo
from dulwich.walk import Walker

from mirage.commands.cli.builtin.git.errors import BadDateError
from mirage.commands.cli.builtin.git.pickaxe import touches
from mirage.commands.spec.types import FlagView
from mirage.utils.dates import iso_timestamp


@dataclass(frozen=True, slots=True)
class LogFlags:
    """The parsed shape of a ``git log`` invocation.

    Args:
        max_count (int | None): ``-n``, how many commits to print.
        oneline (bool): ``--oneline``, one abbreviated row per commit.
        reverse (bool): ``--reverse``, oldest first.
        search (str | None): ``-S``, the pickaxe string.
        since (float | None): ``--since`` as an epoch second.
        until (float | None): ``--until`` as an epoch second.
    """
    max_count: int | None
    oneline: bool
    reverse: bool
    search: str | None
    since: float | None
    until: float | None


def _timestamp(value: str | None, flag: str) -> float | None:
    """Read a date flag as an epoch second, refusing what it cannot read.

    Accepts an ISO-8601 date or a bare epoch second. git accepts far
    more (``2 weeks ago``, ``yesterday``); anything else is refused here
    rather than silently ignored, which would quietly widen the window.

    Args:
        value (str | None): the flag's value.
        flag (str): flag name, for error attribution.
    """
    if value is None:
        return None
    parsed = iso_timestamp(value)
    if parsed is not None:
        return parsed
    try:
        return float(value)
    except ValueError as exc:
        raise BadDateError(flag, value) from exc


def parse_flags(fl: FlagView) -> LogFlags:
    """Read the raw log flag kwargs into a frozen struct.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    return LogFlags(
        max_count=fl.as_int("n"),
        oneline=fl.as_bool("oneline"),
        reverse=fl.as_bool("reverse"),
        search=fl.as_str("S"),
        since=_timestamp(fl.as_str("since"), "--since"),
        until=_timestamp(fl.as_str("until"), "--until"),
    )


def select(repo: BaseRepo, start: Commit, flags: LogFlags) -> list[Commit]:
    """The commits a log invocation prints, in the order it prints them.

    Order of operations is git's: walk history, drop what the filters
    reject, cut to ``-n``, and only then reverse. Reversing last is what
    makes ``-S <name> --reverse`` name the commit that introduced a
    string rather than the most recent one to touch it.

    ``-n`` cannot be pushed into the walker when a pickaxe is active,
    because the limit counts commits that survive the filter, not
    commits visited.

    Args:
        repo (BaseRepo): repository to walk.
        start (Commit): the commit to walk back from.
        flags (LogFlags): the parsed invocation.
    """
    store = repo.object_store
    needle = flags.search.encode() if flags.search is not None else None
    walker = Walker(
        store,
        [start.id],
        max_entries=flags.max_count if needle is None else None,
        since=int(flags.since) if flags.since is not None else None,
        until=int(flags.until) if flags.until is not None else None,
    )
    selected: list[Commit] = []
    for entry in walker:
        commit = entry.commit
        if needle is not None and not touches(store, commit, needle):
            continue
        selected.append(commit)
        if flags.max_count is not None and len(selected) >= flags.max_count:
            break
    if flags.reverse:
        selected.reverse()
    return selected
