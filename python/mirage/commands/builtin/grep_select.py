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

import fnmatch
from dataclasses import dataclass

from mirage.commands.spec.flag_view import FlagView


@dataclass(frozen=True, slots=True)
class FileGlob:
    """One --include/--exclude rule: a basename glob and its verdict.

    Args:
        glob (str): the basename pattern, fnmatch wildcards.
        admit (bool): True for --include, False for --exclude.
    """

    glob: str
    admit: bool


@dataclass(frozen=True, slots=True)
class WalkFilters:
    """GNU's file-selection flags, threaded as one value.

    ``file_globs`` holds the --include/--exclude rules in command-line
    order (the order decides ties, see ``file_admitted``),
    ``exclude_dir`` prunes directories from the -r walk, and ``text``
    (-a) lets the walk read the extensions it would otherwise skip as
    binary. The empty value admits everything, which is what every
    caller without the flags passes.
    """

    file_globs: tuple[FileGlob, ...] = ()
    exclude_dir: tuple[str, ...] = ()
    text: bool = False


def parse_file_globs(fl: FlagView) -> tuple[FileGlob, ...]:
    """The --include/--exclude rules a line typed, in line order, an
    --exclude-from's globs (read by the executor) where it stood.

    The bag lists each dest's values in occurrence order and the dests
    themselves in first-typed order, so the rebuilt list is exact
    unless a line alternates the two kinds three or more times
    (``--include a --exclude b --include c``), where each kind's rules
    stay grouped at its first position. Deliberate approximation: the
    bag is the only channel a generic reads, and it carries no
    per-occurrence positions across two dests.

    Args:
        fl (FlagView): spec-bound view of the parsed flag bag.
    """
    rules: list[FileGlob] = []
    for name in fl.typed_order("include", "exclude", "exclude_from"):
        admit = name == "include"
        rules.extend(
            FileGlob(glob=glob, admit=admit) for glob in fl.as_list(name)
        )
    return tuple(rules)


def file_admitted(path: str, filters: WalkFilters) -> bool:
    """GNU's --include/--exclude gate for one candidate file.

    Globs match the base name with fnmatch wildcards, case sensitively (a
    glob carrying a slash therefore matches nothing, which is what GNU 3.11
    answers too). The rules resolve in command-line order: the last matching
    rule decides, and a file matching none is admitted only when the first
    rule is an exclude (both pinned against GNU 3.11, where
    ``--include='*.txt' --exclude='*.txt'`` skips a .txt file and the
    reversed order searches it). Applies to command-line files exactly as to
    walked ones, which is pinned GNU behavior: an explicit operand --include
    passes over is silently no match, not an error.

    Args:
        path (str): candidate file path, any path space.
        filters (WalkFilters): the parsed selection flags.
    """
    rules = filters.file_globs
    if not rules:
        return True
    base = path.rstrip("/").rsplit("/", 1)[-1]
    verdict = not rules[0].admit
    for rule in rules:
        if fnmatch.fnmatchcase(base, rule.glob):
            verdict = rule.admit
    return verdict


def dir_admitted(path: str, filters: WalkFilters) -> bool:
    """Whether the -r walk may descend into this directory.

    Args:
        path (str): candidate directory path, any path space.
        filters (WalkFilters): the parsed selection flags.
    """
    base = path.rstrip("/").rsplit("/", 1)[-1]
    return not any(
        fnmatch.fnmatchcase(base, glob) for glob in filters.exclude_dir
    )
