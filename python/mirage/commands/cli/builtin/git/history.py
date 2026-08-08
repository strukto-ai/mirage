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

from dulwich.objects import Commit, ObjectID, Tag
from dulwich.refs import HEADREF, LOCAL_BRANCH_PREFIX, LOCAL_TAG_PREFIX
from dulwich.repo import BaseRepo
from dulwich.walk import Walker

from mirage.commands.cli.builtin.git.errors import (BadDateError,
                                                    UnrecognizedArgumentError)
from mirage.commands.cli.builtin.git.format import (MEDIUM, LogFormat,
                                                    parse_pretty)
from mirage.commands.cli.builtin.git.pickaxe import touches
from mirage.commands.spec.types import FlagView
from mirage.utils.dates import iso_timestamp

REMOTE_PREFIX = b"refs/remotes/"


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
        all_refs (bool): ``--all``, start from every ref as well.
        pretty (LogFormat): how each commit renders; medium unless
            ``--oneline`` or ``--pretty``/``--format`` said otherwise.
        abbrev_commit (bool): print abbreviated ids, which ``--oneline``
            implies and ``--pretty=oneline`` alone does not.
    """
    max_count: int | None
    oneline: bool
    reverse: bool
    search: str | None
    since: float | None
    until: float | None
    all_refs: bool = False
    pretty: LogFormat = MEDIUM
    abbrev_commit: bool = False


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


def pretty_value(fl: FlagView) -> str | None:
    """The --pretty/--format value, honoring the bare optional form.

    Both spellings set the same variable in git; ``--format`` is read
    first when both appear on one line, an ordering the flag bag cannot
    preserve. A bare ``--pretty`` means medium, git's own default, but
    pretty.c reads ``--format`` only in its =value form, so the bare
    spelling gets git's own fatal (pinned: 2.37 and 2.54, exit 128).

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.

    Raises:
        UnrecognizedArgumentError: a bare ``--format`` with no value.
    """
    for key in ("format", "pretty"):
        raw = fl.raw(key)
        if isinstance(raw, str):
            return raw
        if raw is True:
            if key == "format":
                raise UnrecognizedArgumentError("--format")
            return "medium"
    return None


def parse_flags(fl: FlagView) -> LogFlags:
    """Read the raw log flag kwargs into a frozen struct.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    oneline = fl.as_bool("oneline")
    pretty = LogFormat(kind="oneline") if oneline else MEDIUM
    spelled = pretty_value(fl)
    if spelled is not None:
        pretty = parse_pretty(spelled)
    return LogFlags(
        max_count=fl.as_int("n"),
        oneline=oneline,
        reverse=fl.as_bool("reverse"),
        search=fl.as_str("S"),
        since=_timestamp(fl.as_str("since"), "--since"),
        until=_timestamp(fl.as_str("until"), "--until"),
        all_refs=fl.as_bool("all"),
        pretty=pretty,
        abbrev_commit=oneline,
    )


def _peel_to_commit(repo: BaseRepo, sha: bytes) -> Commit | None:
    """Follow tag objects down to the commit a ref ultimately names.

    Args:
        repo (BaseRepo): repository whose store resolves the ids.
        sha (bytes): hex object id a ref points at.
    """
    obj = repo.object_store[ObjectID(sha)]
    while isinstance(obj, Tag):
        _, target = obj.object
        obj = repo.object_store[ObjectID(target)]
    return obj if isinstance(obj, Commit) else None


def ref_commits(repo: BaseRepo) -> list[Commit]:
    """Every commit a ref points at, tags peeled, for ``--all``.

    Args:
        repo (BaseRepo): repository whose refs to enumerate.
    """
    commits: list[Commit] = []
    for name in sorted(repo.refs.allkeys()):
        try:
            sha = repo.refs[name]
        except KeyError:
            # A symref to an unborn branch names nothing yet.
            continue
        commit = _peel_to_commit(repo, sha)
        if commit is not None:
            commits.append(commit)
    return commits


def decorations(repo: BaseRepo) -> dict[bytes, list[str]]:
    """Ref labels per commit, in the order git prints them.

    git walks refs alphabetically and prepends each label, so a
    commit's labels read in reverse ref order; HEAD is pulled to the
    front, spelled ``HEAD -> branch`` when attached (the branch's own
    label is absorbed) and ``HEAD`` alone when detached. Pinned against
    git 2.50.

    Args:
        repo (BaseRepo): repository whose refs to enumerate.
    """
    labels: dict[bytes, list[str]] = {}
    for name in sorted(repo.refs.allkeys()):
        if name == HEADREF:
            continue
        try:
            sha = repo.refs[name]
        except KeyError:
            continue
        commit = _peel_to_commit(repo, sha)
        if commit is None:
            continue
        labels.setdefault(commit.id, []).insert(0, _ref_label(name))
    _decorate_head(repo, labels)
    return labels


def _ref_label(name: bytes) -> str:
    """One ref's decoration label, in git's spelling.

    Args:
        name (bytes): the full ref name.
    """
    text = name.decode("utf-8", errors="replace")
    if name.startswith(LOCAL_TAG_PREFIX):
        return f"tag: {text[len(LOCAL_TAG_PREFIX):]}"
    if name.startswith(LOCAL_BRANCH_PREFIX):
        return text[len(LOCAL_BRANCH_PREFIX):]
    if name.startswith(REMOTE_PREFIX):
        return text[len(REMOTE_PREFIX):]
    return text


def _decorate_head(repo: BaseRepo, labels: dict[bytes, list[str]]) -> None:
    """Prepend the HEAD label, absorbing the attached branch's own.

    Args:
        repo (BaseRepo): repository whose HEAD to read.
        labels (dict[bytes, list[str]]): per-commit labels to amend.
    """
    try:
        chain, sha = repo.refs.follow(HEADREF)
    except KeyError:
        return
    if sha is None:
        return
    commit = _peel_to_commit(repo, sha)
    if commit is None:
        return
    names = labels.setdefault(commit.id, [])
    if len(chain) > 1:
        branch = _ref_label(chain[-1])
        if branch in names:
            names.remove(branch)
        names.insert(0, f"HEAD -> {branch}")
    else:
        names.insert(0, "HEAD")


def select(repo: BaseRepo, starts: list[Commit],
           flags: LogFlags) -> list[Commit]:
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
        starts (list[Commit]): the commits to walk back from; more than
            one when ``--all`` seeds every ref.
        flags (LogFlags): the parsed invocation.
    """
    store = repo.object_store
    needle = flags.search.encode() if flags.search is not None else None
    include: list[ObjectID] = []
    for start in starts:
        if start.id not in include:
            include.append(ObjectID(start.id))
    walker = Walker(
        store,
        include,
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
