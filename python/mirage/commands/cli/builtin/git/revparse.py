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

from dulwich.objects import Commit, ObjectID
from dulwich.objectspec import parse_commit
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.errors import AmbiguousArgumentError
from mirage.commands.cli.builtin.git.types import AncestryStep

HEAD = "HEAD"
ANCESTOR = "~"
PARENT = "^"
SUFFIXES = (ANCESTOR, PARENT)


def split_revision(revision: str) -> tuple[str, tuple[AncestryStep, ...]]:
    """Split a revision into its base and its ancestry suffixes.

    ``HEAD~2^2`` is a base plus two steps. Splitting on the first ``~``
    or ``^`` is safe because git forbids both characters in ref names,
    so neither can belong to the base.

    Args:
        revision (str): revision as the user spelled it.
    """
    index = next(
        (i for i, ch in enumerate(revision) if ch in SUFFIXES),
        len(revision),
    )
    base, rest = revision[:index], revision[index:]
    steps: list[AncestryStep] = []
    position = 0
    while position < len(rest):
        kind = rest[position]
        position += 1
        digits = ""
        while position < len(rest) and rest[position].isdigit():
            digits += rest[position]
            position += 1
        if digits == "":
            count = 1
        else:
            count = int(digits)
        steps.append(AncestryStep(first_parent=kind == ANCESTOR, count=count))
    return base or HEAD, tuple(steps)


def _step(repo: BaseRepo, commit: Commit, step: AncestryStep,
          revision: str) -> Commit:
    """Apply one ancestry suffix to a commit.

    ``~n`` walks n generations along first parents; ``^n`` takes the
    n-th parent of this commit, and ``^0`` is the commit itself (git's
    way of spelling "the commit a tag points at").

    Args:
        repo (BaseRepo): repository to resolve parents against.
        commit (Commit): the commit the previous step produced.
        step (AncestryStep): the suffix to apply.
        revision (str): the whole revision, for error attribution.
    """
    if step.first_parent:
        for _ in range(step.count):
            if not commit.parents:
                raise AmbiguousArgumentError(revision)
            commit = _commit_at(repo, commit.parents[0], revision)
        return commit
    if step.count == 0:
        return commit
    if step.count > len(commit.parents):
        raise AmbiguousArgumentError(revision)
    return _commit_at(repo, commit.parents[step.count - 1], revision)


def _commit_at(repo: BaseRepo, sha: ObjectID, revision: str) -> Commit:
    """Load one commit by object id, or report the revision as unknown.

    Args:
        repo (BaseRepo): repository holding the object.
        sha (ObjectID): hex object id.
        revision (str): the whole revision, for error attribution.
    """
    try:
        obj = repo.object_store[sha]
    except KeyError as exc:
        raise AmbiguousArgumentError(revision) from exc
    if not isinstance(obj, Commit):
        raise AmbiguousArgumentError(revision)
    return obj


def resolve_commit(repo: BaseRepo, revision: str) -> Commit:
    """Resolve a revision to a commit, ancestry suffixes included.

    dulwich resolves refs, full ids and unambiguous short ids, but knows
    nothing about ``~`` and ``^``; those are applied here, on top of
    whatever its own parser returns.

    Args:
        repo (BaseRepo): repository to resolve against.
        revision (str): revision as the user spelled it.
    """
    base, steps = split_revision(revision)
    try:
        commit = parse_commit(repo, base)
    except (KeyError, ValueError) as exc:
        raise AmbiguousArgumentError(revision) from exc
    for step in steps:
        commit = _step(repo, commit, step, revision)
    return commit
