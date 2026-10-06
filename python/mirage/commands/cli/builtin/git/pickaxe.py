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
from collections.abc import Iterator
from difflib import SequenceMatcher

from dulwich.diff_tree import tree_changes
from dulwich.object_store import BaseObjectStore
from dulwich.objects import Blob, Commit, ObjectID

from mirage.commands.cli.builtin.git.patch import byte_lines
from mirage.commands.cli.builtin.git.summary import BINARY_SNIFF

EMPTY_TREE = None


def _blob(store: BaseObjectStore, sha: ObjectID | None) -> bytes:
    """A blob's bytes, empty for a side that does not exist.

    Args:
        store (BaseObjectStore): object database holding the blob.
        sha (ObjectID | None): blob id, None when the side does not
            exist.
    """
    if sha is None:
        return b""
    obj = store[sha]
    return obj.data if isinstance(obj, Blob) else b""


def _match_from(
    text: str, pattern: re.Pattern[str], start: int, bol: bool
) -> tuple[int, int] | None:
    """The first match at or after ``start`` inside one line, as glibc's
    regexec finds it under REG_NEWLINE: ``^`` holds after each newline past
    ``start``, and at ``start`` itself only while ``bol``.

    Args:
        text (str): the blob's text.
        pattern (re.Pattern[str]): the compiled expression.
        start (int): where the search starts.
        bol (bool): whether ``start`` may match ``^``, git's first search.
    """
    at = start
    while True:
        begin = text.rfind("\n", 0, at) + 1
        end = text.find("\n", at)
        end = len(text) if end < 0 else end
        if at == start == begin and not bol:
            found = pattern.search("\0" + text[begin:end], 1)
            shift = begin - 1
        else:
            found, shift = pattern.search(text[begin:end], at - begin), begin
        if found is not None:
            return found.start() + shift, found.end() + shift
        if end == len(text):
            return None
        at = end + 1


def contains(text: str, pattern: re.Pattern[str]) -> int:
    """How many times a pattern matches a blob, git's ``contains`` under
    ``--pickaxe-regex``: each search resumes where the last match ended, a
    step further after an empty one, and ``^`` never holds where it resumes.

    Args:
        text (str): the blob's text.
        pattern (re.Pattern[str]): the compiled expression.
    """
    count, start = 0, 0
    while start < len(text):
        found = _match_from(text, pattern, start, count == 0)
        if found is None:
            break
        count += 1
        start = found[1] + (found[0] == found[1] and found[1] < len(text))
    return count


def _occurrences(
    store: BaseObjectStore,
    sha: ObjectID | None,
    needle: bytes | re.Pattern[str],
    ignore_case: bool,
) -> int:
    """How many times a string appears in one blob, or a pattern matches it
    as git counts under ``--pickaxe-regex``.

    Args:
        store (BaseObjectStore): object database holding the blob.
        sha (ObjectID | None): blob id, None when the side does not
            exist.
        needle (bytes | re.Pattern[str]): the string being counted,
            already folded under ``ignore_case``, or the pattern.
        ignore_case (bool): fold the blob's ASCII letters to lower case,
            the table git folds a ``-S`` string through under ``-i``.
    """
    data = _blob(store, sha)
    if not isinstance(needle, re.Pattern):
        return (data.lower() if ignore_case else data).count(needle)
    return contains(data.decode("utf-8", "replace"), needle)


def _changes(
    store: BaseObjectStore, commit: Commit
) -> Iterator[tuple[ObjectID | None, ObjectID | None]]:
    """The old and new blob ids of every path a commit changed against
    its first parent, or against nothing for a root commit.

    Args:
        store (BaseObjectStore): object database holding the trees.
        commit (Commit): the commit.
    """
    parent_tree = EMPTY_TREE
    if commit.parents:
        parent = store[commit.parents[0]]
        assert isinstance(parent, Commit)
        parent_tree = parent.tree
    for change in tree_changes(store, parent_tree, commit.tree):
        old = change.old.sha if change.old is not None else None
        new = change.new.sha if change.new is not None else None
        yield old, new


def greps(
    store: BaseObjectStore, commit: Commit, pattern: re.Pattern[str]
) -> bool:
    """Whether a commit's diff adds or removes a line the pattern matches,
    git's ``-G``; a binary side is skipped, as git does without ``--text``.

    Args:
        store (BaseObjectStore): object database holding the trees.
        commit (Commit): the commit to test.
        pattern (re.Pattern[str]): the compiled ``-G`` expression.
    """
    for old_sha, new_sha in _changes(store, commit):
        old, new = _blob(store, old_sha), _blob(store, new_sha)
        if b"\0" in old[:BINARY_SNIFF] or b"\0" in new[:BINARY_SNIFF]:
            continue
        before, after = byte_lines(old), byte_lines(new)
        matcher = SequenceMatcher(a=before, b=after, autojunk=False)
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == "equal":
                continue
            for line in (*before[i1:i2], *after[j1:j2]):
                text = line.decode("utf-8", "replace").removesuffix("\n")
                if pattern.search(text):
                    return True
    return False


def touches(
    store: BaseObjectStore,
    commit: Commit,
    needle: bytes | re.Pattern[str],
    ignore_case: bool = False,
) -> bool:
    """Whether a commit changed the number of occurrences of a string.

    This is git's ``-S`` (pickaxe), and it is deliberately not a grep: a
    commit that merely moves a line containing the string does not
    change how many times the string appears, so it is not reported. The
    commit that *introduced* the string is, which is what makes
    ``-S <name> --reverse`` answer "where did this come from".

    Compared against the first parent, or against nothing for a root
    commit, so the objects a root commit adds all count as introduced.
    ``-i`` counts without regard to ASCII case; under
    ``--pickaxe-regex`` the needle is a compiled pattern, which carries
    its own case folding.

    Args:
        store (BaseObjectStore): object database holding the trees.
        commit (Commit): the commit to test.
        needle (bytes | re.Pattern[str]): the string being counted, or
            the ``--pickaxe-regex`` pattern.
        ignore_case (bool): ``-i``.
    """
    if ignore_case and isinstance(needle, bytes):
        needle = needle.lower()
    for old, new in _changes(store, commit):
        if _occurrences(store, old, needle, ignore_case) != _occurrences(
            store, new, needle, ignore_case
        ):
            return True
    return False
