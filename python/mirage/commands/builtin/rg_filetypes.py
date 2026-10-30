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

from mirage.commands.builtin.rg_glob import Verdict, compile_glob
from mirage.commands.errors import UsageError
from mirage.utils.generated.rg_types import DEFAULT_TYPES

# ripgrep's refusal of a --type-add it cannot read, whatever is wrong
# with it (a missing glob, a bad name, `all`, an unknown include), exit 2
# (ripgrep 14.1.1).
INVALID_DEFINITION = (
    "rg: invalid definition (format is type:glob, e.g., html:*.html)"
)
# The name that selects every type at once; it cannot be defined.
ALL_TYPES = "all"


def _add_glob(defs: dict[str, list[str]], name: str, glob: str) -> None:
    """Add one glob to a type, creating the type if it is new.

    Args:
        defs (dict[str, list[str]]): the type table being built.
        name (str): the type's name, alphanumeric and never ``all``.
        glob (str): the glob to add.
    """
    if name == ALL_TYPES or not name.isalnum():
        raise UsageError(INVALID_DEFINITION)
    defs.setdefault(name, []).append(glob)


def add_definition(defs: dict[str, list[str]], definition: str) -> None:
    """Apply one --type-add, ``name:glob`` or ``name:include:t1,t2``.

    Args:
        defs (dict[str, list[str]]): the type table being built.
        definition (str): the value as typed.

    Raises:
        UsageError: the definition is malformed, in ripgrep's words.
    """
    parts = definition.split(":")
    if len(parts) == 2:
        name, glob = parts
        if not name or not glob:
            raise UsageError(INVALID_DEFINITION)
        _add_glob(defs, name, glob)
        return
    if len(parts) == 3:
        name, keyword, included = parts
        if not name or keyword != "include" or not included:
            raise UsageError(INVALID_DEFINITION)
        names = included.split(",")
        if any(t not in defs for t in names):
            raise UsageError(INVALID_DEFINITION)
        for t in names:
            for glob in list(defs[t]):
                _add_glob(defs, name, glob)
        return
    raise UsageError(INVALID_DEFINITION)


class FileTypes:
    """ripgrep's -t/-T matcher (the ignore crate's ``Types``).

    Types match a file's name, never a directory. The last selection
    whose globs match decides: -t keeps the file whatever the hidden
    filter says, -T drops it. Once any -t is given, a file no selected
    type matches is dropped.

    Args:
        changes (Sequence[tuple[str, str]]): the --type-clear and
            --type-add values in line order, each as ``("clear", name)``
            or ``("add", definition)``.
        selections (Sequence[tuple[str, bool]]): the -t and -T names in
            line order, each with whether it negates (-T).

    Raises:
        UsageError: a definition is malformed, a selected type does not
            exist, or a selected glob does not compile.
    """

    def __init__(
        self,
        changes: Sequence[tuple[str, str]],
        selections: Sequence[tuple[str, bool]],
    ) -> None:
        defs = {name: list(globs) for name, globs in DEFAULT_TYPES.items()}
        for kind, value in changes:
            if kind == "clear":
                defs.pop(value, None)
            else:
                add_definition(defs, value)
        self.definitions = defs
        self._selected = any(not negated for _, negated in selections)
        globs: list[tuple[re.Pattern[str], bool]] = []
        for name, negated in selections:
            if name == ALL_TYPES:
                chosen = [g for gs in defs.values() for g in gs]
            elif name in defs:
                chosen = defs[name]
            else:
                raise UsageError(f"rg: unrecognized file type: {name}")
            globs.extend((compile_glob(g), negated) for g in chosen)
        self._globs = tuple(globs)

    def verdict(self, name: str, is_dir: bool) -> Verdict:
        """What the selections say about one walked entry.

        Args:
            name (str): the entry's file name.
            is_dir (bool): whether it is a directory.
        """
        if is_dir or not self._globs:
            return Verdict.NONE
        last: bool | None = None
        for matcher, negated in self._globs:
            if matcher.fullmatch(name):
                last = negated
        if last is None:
            return Verdict.IGNORE if self._selected else Verdict.NONE
        return Verdict.IGNORE if last else Verdict.WHITELIST


def type_listing(defs: dict[str, list[str]]) -> list[str]:
    """--type-list: every type and its globs, both sorted, one per line.

    Args:
        defs (dict[str, list[str]]): the type table after --type-add and
            --type-clear.
    """
    return [
        f"{name}: {', '.join(sorted(defs[name]))}" for name in sorted(defs)
    ]
