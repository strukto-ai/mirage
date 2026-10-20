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
from difflib import SequenceMatcher

from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.patch import blob_data, byte_lines
from mirage.commands.cli.builtin.git.summary import BINARY_SNIFF
from mirage.rs.regex import PosixRegex
from mirage.shell.bytes import byte_view


@dataclass(frozen=True, slots=True)
class Pickaxe:
    """A ``-S`` or ``-G`` search, which git runs on every file pair a
    diff compares, once renames are paired.

    Args:
        needle (bytes | PosixRegex | None): ``-S``'s string, or its
            pattern under ``--pickaxe-regex``; None for ``-G``.
        changed (PosixRegex | None): ``-G``'s pattern; None for ``-S``.
        ignore_case (bool): ``-i``, which folds a ``-S`` string's ASCII
            letters.
        force_text (bool): ``--text``: ``-G`` reads a binary side's
            lines too.
        every (bool): ``--pickaxe-all``: one matching pair keeps every
            pair its comparison found.
    """

    needle: bytes | PosixRegex | None = None
    changed: PosixRegex | None = None
    ignore_case: bool = False
    force_text: bool = False
    every: bool = False


def contains(text: str, pattern: PosixRegex) -> int:
    """How many times a pattern matches a blob, git's ``contains`` under
    ``--pickaxe-regex`` and glibc's REG_NEWLINE: a match stays in its line,
    each search resumes where the last match ended (a step further after an
    empty one), and ``^`` never holds where it resumes. mirage-rs counts
    the whole blob in one request.

    Args:
        text (str): the blob's text.
        pattern (PosixRegex): the compiled expression.
    """
    return pattern.contains(text)


def _occurrences(
    repo: BaseRepo,
    entry: tuple[int, bytes] | None,
    needle: bytes | PosixRegex,
    ignore_case: bool,
) -> int:
    """How many times a string appears in one side, or a pattern matches
    it as git counts under ``--pickaxe-regex``.

    Args:
        repo (BaseRepo): repository holding the blob.
        entry (tuple[int, bytes] | None): the side's (mode, id), None
            when it does not exist.
        needle (bytes | PosixRegex): the string being counted,
            already folded under ``ignore_case``, or the pattern.
        ignore_case (bool): fold the blob's ASCII letters to lower case,
            the table git folds a ``-S`` string through under ``-i``.
    """
    data = blob_data(repo, entry)
    if not isinstance(needle, PosixRegex):
        return (data.lower() if ignore_case else data).count(needle)
    return contains(byte_view(data, needle.utf8), needle)


def _greps(
    repo: BaseRepo,
    old_entry: tuple[int, bytes] | None,
    new_entry: tuple[int, bytes] | None,
    pattern: PosixRegex,
    force_text: bool,
) -> bool:
    """Whether a pair's diff adds or removes a line the pattern matches,
    git's ``-G``; a binary side is skipped, as git does without
    ``--text``.

    Args:
        repo (BaseRepo): repository holding the blobs.
        old_entry (tuple[int, bytes] | None): the old side's (mode, id).
        new_entry (tuple[int, bytes] | None): the new side's (mode, id).
        pattern (PosixRegex): the compiled ``-G`` expression.
        force_text (bool): include binary changed lines under ``--text``.
    """
    old = blob_data(repo, old_entry)
    new = blob_data(repo, new_entry)
    if not force_text and (
        b"\0" in old[:BINARY_SNIFF] or b"\0" in new[:BINARY_SNIFF]
    ):
        return False
    before, after = byte_lines(old), byte_lines(new)
    matcher = SequenceMatcher(a=before, b=after, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        for line in (*before[i1:i2], *after[j1:j2]):
            text = byte_view(line, pattern.utf8).removesuffix("\n")
            if pattern.search(text):
                return True
    return False


def matches(
    repo: BaseRepo,
    pickaxe: Pickaxe,
    old: tuple[int, bytes] | None,
    new: tuple[int, bytes] | None,
) -> bool:
    """Whether one file pair passes the pickaxe.

    ``-S`` is deliberately not a grep: a pair that merely moves a line
    holding the string leaves its count alone, so it does not match,
    and the commit that *introduced* the string does, which is what
    makes ``-S <name> --reverse`` answer "where did this come from". A
    missing side holds nothing, so whatever a new file adds counts as
    introduced, and each side reads the way ``blob_data`` reads it, so
    a gitlink is its ``Subproject commit`` line, as git's pickaxe sees
    it. ``-i`` counts without regard to ASCII case; a
    ``--pickaxe-regex`` pattern carries its own case folding.

    Args:
        repo (BaseRepo): repository holding the blobs.
        pickaxe (Pickaxe): the search.
        old (tuple[int, bytes] | None): the old side's (mode, id), None
            when the path is new.
        new (tuple[int, bytes] | None): the new side's (mode, id), None
            when the path is gone.
    """
    if pickaxe.changed is not None:
        return _greps(repo, old, new, pickaxe.changed, pickaxe.force_text)
    needle = pickaxe.needle
    if needle is None:
        return True
    if pickaxe.ignore_case and isinstance(needle, bytes):
        needle = needle.lower()
    return _occurrences(repo, old, needle, pickaxe.ignore_case) != (
        _occurrences(repo, new, needle, pickaxe.ignore_case)
    )
