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
from dataclasses import dataclass
from enum import Enum

from mirage.commands.errors import UsageError

# globset's own words for a glob it cannot compile (ripgrep 14.1.1).
UNCLOSED_CLASS = "unclosed character class; missing ']'"
UNCLOSED_ALTERNATES = ("unclosed alternate group; missing '}' "
                       "(maybe escape '{' with '[{]'?)")
UNOPENED_ALTERNATES = ("unopened alternate group; missing '{' "
                       "(maybe escape '}' with '[}]'?)")
NESTED_ALTERNATES = "nested alternate groups are not allowed"
DANGLING_ESCAPE = "dangling '\\'"


class Verdict(Enum):
    """What one of ripgrep's path matchers says about a path: nothing,
    leave it out, or keep it whatever the later filters would say (the
    ignore crate's ``Match``)."""

    NONE = "none"
    IGNORE = "ignore"
    WHITELIST = "whitelist"


def glob_error(glob: str, reason: str) -> UsageError:
    """ripgrep's refusal of a glob it cannot compile, exit 2.

    Args:
        glob (str): the glob as the line typed it.
        reason (str): globset's reason.
    """
    return UsageError(f"rg: error parsing glob '{glob}': {reason}")


def _class_source(shown: str, text: str, i: int) -> tuple[str, int]:
    """One ``[...]`` class as regex source, and where the text resumes.

    Args:
        shown (str): the glob as typed, for the refusal wording.
        text (str): the text holding the class.
        i (int): the index just past the opening ``[``.
    """
    negated = i < len(text) and text[i] in "!^"
    if negated:
        i += 1
    members: list[str] = []
    first = True
    while i < len(text):
        ch = text[i]
        if ch == "]" and not first:
            prefix = "[^" if negated else "["
            return prefix + "".join(members) + "]", i + 1
        first = False
        if (i + 2 < len(text) and text[i + 1] == "-" and text[i + 2] != "]"):
            members.append(re.escape(ch) + "-" + re.escape(text[i + 2]))
            i += 3
            continue
        members.append(re.escape(ch))
        i += 1
    raise glob_error(shown, UNCLOSED_CLASS)


def _star_source(glob: str, i: int, stars: int) -> tuple[str, int]:
    """A run of ``*`` as regex source, and where the glob resumes.

    ``**`` recurses only as a whole path component (at the start or after
    ``/``, and at the end or before ``/``); anywhere else it is two plain
    stars, which never cross ``/`` (globset with literal separators).

    Args:
        glob (str): the whole glob.
        i (int): the index just past the run.
        stars (int): how many stars the run holds.
    """
    start = i - stars
    if stars < 2:
        return "[^/]*", i
    at_start = start == 0 or glob[start - 1] == "/"
    at_end = i == len(glob) or glob[i] == "/"
    if not (at_start and at_end):
        return "[^/]*", i
    if i == len(glob):
        return ".*", i
    # `**/` (leading or between components) is zero or more whole
    # components; the `/` it ends with is part of it.
    return "(?:.*/)?", i + 1


def _glob_body(glob: str, text: str, nested: bool) -> str:
    """Regex source for ``text``, one alternative of ``glob`` or all of it.

    Args:
        glob (str): the whole glob, for the refusal wording.
        text (str): the part to translate.
        nested (bool): whether ``text`` already sits inside ``{...}``.
    """
    out: list[str] = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "\\":
            if i + 1 >= len(text):
                raise glob_error(glob, DANGLING_ESCAPE)
            out.append(re.escape(text[i + 1]))
            i += 2
        elif ch == "*":
            j = i
            while j < len(text) and text[j] == "*":
                j += 1
            source, i = _star_source(text, j, j - i)
            out.append(source)
        elif ch == "?":
            out.append("[^/]")
            i += 1
        elif ch == "[":
            source, i = _class_source(glob, text, i + 1)
            out.append(source)
        elif ch == "{":
            if nested:
                raise glob_error(glob, NESTED_ALTERNATES)
            close, parts = _alternates(glob, text, i + 1)
            out.append("(?:" + "|".join(
                _glob_body(glob, part, True) for part in parts) + ")")
            i = close + 1
        elif ch == "}" and not nested:
            raise glob_error(glob, UNOPENED_ALTERNATES)
        else:
            out.append(re.escape(ch))
            i += 1
    return "".join(out)


def _alternates(glob: str, text: str, i: int) -> tuple[int, list[str]]:
    """The alternatives of one ``{...}`` group and the index of its ``}``.

    Args:
        glob (str): the whole glob, for the refusal wording.
        text (str): the text holding the group.
        i (int): the index just past the opening ``{``.
    """
    parts: list[str] = []
    current: list[str] = []
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text):
            current.append(text[i:i + 2])
            i += 2
            continue
        if ch == "[":
            _, end = _class_source(glob, text, i + 1)
            current.append(text[i:end])
            i = end
            continue
        if ch == "{":
            raise glob_error(glob, NESTED_ALTERNATES)
        if ch == "}":
            parts.append("".join(current))
            return i, parts
        if ch == ",":
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
        i += 1
    raise glob_error(glob, UNCLOSED_ALTERNATES)


def compile_glob(glob: str,
                 case_insensitive: bool = False,
                 shown: str | None = None) -> re.Pattern[str]:
    """ripgrep's glob syntax as one anchored matcher.

    globset with literal separators and backslash escapes, which is what
    ripgrep builds every ``-g`` and ``--type`` glob with: ``*`` and ``?``
    stay inside one path component, ``**`` spans components, ``[...]``
    and ``{a,b}`` are classes and alternatives.

    Args:
        glob (str): the glob to compile.
        case_insensitive (bool): --iglob / --glob-case-insensitive.
        shown (str | None): the glob as the line typed it, when that is
            not ``glob`` itself (a ``-g`` line after ignore-rule
            rewriting), for the refusal wording.

    Raises:
        UsageError: the glob does not compile, in ripgrep's words.
    """
    source = _glob_body(glob if shown is None else shown, glob, False)
    return re.compile(source, re.IGNORECASE if case_insensitive else 0)


@dataclass(frozen=True, slots=True)
class OverrideGlob:
    """One ``-g`` glob read as ripgrep reads it: a gitignore line whose
    sense is inverted, so a plain glob keeps a path and ``!glob`` drops it.

    Args:
        matcher (re.Pattern[str]): the compiled glob, matched whole.
        keep (bool): a plain glob; False for ``!glob``.
        dir_only (bool): the glob ended in ``/``, so it speaks only for
            directories.
    """

    matcher: re.Pattern[str]
    keep: bool
    dir_only: bool


def override_glob(line: str, case_insensitive: bool) -> OverrideGlob | None:
    """Parse one ``-g`` value the way the ignore crate parses a gitignore
    line, or None for a line that says nothing (empty, or a ``#`` comment).

    A glob with no ``/`` in it matches at any depth; one with a ``/``, or
    a leading ``/``, is anchored to the path as walked. A trailing ``/``
    limits it to directories, and ``dir/**`` keeps everything below the
    directory but not the directory itself.

    Args:
        line (str): the value as typed.
        case_insensitive (bool): --iglob / --glob-case-insensitive.
    """
    if line.startswith("#"):
        return None
    if not line.endswith("\\ "):
        line = line.rstrip()
    if not line:
        return None
    shown = line
    keep = True
    absolute = False
    if line.startswith("\\!") or line.startswith("\\#"):
        line = line[1:]
        absolute = line.startswith("/")
    else:
        if line.startswith("!"):
            keep = False
            line = line[1:]
        if line.startswith("/"):
            line = line[1:]
            absolute = True
    dir_only = False
    if line.endswith("/"):
        dir_only = True
        line = line[:-1]
        if line.endswith("\\"):
            line = line[:-1]
    actual = line
    if not absolute and "/" not in line and not (actual.startswith("**/")
                                                 or actual == "**"):
        actual = "**/" + actual
    if actual.endswith("/**"):
        actual += "/*"
    return OverrideGlob(compile_glob(actual, case_insensitive, shown), keep,
                        dir_only)


class Overrides:
    """ripgrep's ``-g``/``--iglob`` matcher (the ignore crate's
    ``Override``).

    The last glob that matches a path decides it, a ``!`` one dropping it
    and a plain one keeping it whatever the type and hidden filters would
    say. Once any plain glob exists, a file no glob matches is dropped,
    while a directory no glob matches is still walked.

    Args:
        globs (Sequence[str]): the ``-g`` values, in order.
        iglobs (Sequence[str]): the ``--iglob`` values, which ripgrep adds
            after every ``-g`` whatever order the line gave them.
        case_insensitive (bool): --glob-case-insensitive.
    """

    def __init__(self, globs: Sequence[str], iglobs: Sequence[str],
                 case_insensitive: bool) -> None:
        parsed = [override_glob(g, case_insensitive) for g in globs]
        parsed += [override_glob(g, True) for g in iglobs]
        self._globs = tuple(g for g in parsed if g is not None)
        self._keeps = any(g.keep for g in self._globs)

    def verdict(self, path: str, is_dir: bool) -> Verdict:
        """What the globs say about one walked path.

        Args:
            path (str): the path as ripgrep matches it (``walk_candidate``).
            is_dir (bool): whether the path is a directory.
        """
        if not self._globs:
            return Verdict.NONE
        for glob in reversed(self._globs):
            if glob.dir_only and not is_dir:
                continue
            if glob.matcher.fullmatch(path):
                return Verdict.WHITELIST if glob.keep else Verdict.IGNORE
        if self._keeps and not is_dir:
            return Verdict.IGNORE
        return Verdict.NONE


def walk_candidate(shown: str, cwd: str) -> str:
    """The path ripgrep matches a walked entry's globs against.

    The walked path as printed, with a leading ``./`` dropped and the
    working directory stripped off an absolute one, which is what the
    ignore crate's ``strip`` does with the override root (the cwd).

    Args:
        shown (str): the entry's path as rg prints it.
        cwd (str): the session's working directory.
    """
    path = shown[2:] if shown.startswith("./") else shown
    if not path.startswith("/"):
        return path
    root = cwd.rstrip("/")
    if not root:
        return path.lstrip("/")
    if path.startswith(root + "/"):
        return path[len(root) + 1:]
    return path
