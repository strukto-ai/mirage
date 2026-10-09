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
from mirage.shell.bytes import decode_text

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


def contains(text: str, pattern: re.Pattern[str]) -> int:
    """How many times a pattern matches a blob, git's ``contains`` under
    ``--pickaxe-regex`` and glibc's REG_NEWLINE: a match stays in its line,
    each search resumes where the last match ended (a step further after an
    empty one), and ``^`` never holds where it resumes. Each line is sliced
    once, however many matches it holds.

    Args:
        text (str): the blob's text.
        pattern (re.Pattern[str]): the compiled expression.
    """
    count, start, begin = 0, 0, 0
    while start < len(text) and begin <= len(text):
        end = text.find("\n", begin)
        end = len(text) if end < 0 else end
        line = text[begin:end]
        while start <= end and start < len(text):
            if count and start == begin:
                found, shift = pattern.search("\0" + line, 1), begin - 1
            else:
                found = pattern.search(line, max(start - begin, 0))
                shift = begin
            if found is None:
                break
            count += 1
            stop = found.end() + shift
            start = stop + (found.start() == found.end() and stop < len(text))
        begin = end + 1
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
    return contains(decode_text(data), needle)


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
    store: BaseObjectStore,
    commit: Commit,
    pattern: re.Pattern[str],
    force_text: bool = False,
) -> bool:
    """Whether a commit's diff adds or removes a line the pattern matches,
    git's ``-G``; a binary side is skipped, as git does without ``--text``.

    Args:
        store (BaseObjectStore): object database holding the trees.
        commit (Commit): the commit to test.
        pattern (re.Pattern[str]): the compiled ``-G`` expression.
        force_text (bool): include binary changed lines under ``--text``.
    """
    for old_sha, new_sha in _changes(store, commit):
        old, new = _blob(store, old_sha), _blob(store, new_sha)
        if not force_text and (
            b"\0" in old[:BINARY_SNIFF] or b"\0" in new[:BINARY_SNIFF]
        ):
            continue
        before, after = byte_lines(old), byte_lines(new)
        matcher = SequenceMatcher(a=before, b=after, autojunk=False)
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == "equal":
                continue
            for line in (*before[i1:i2], *after[j1:j2]):
                text = decode_text(line).removesuffix("\n")
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
