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

from mirage.commands.spec.types import ValueType
from mirage.types import PathSpec
from mirage.workspace.expand.classify.heuristic import classify_word
from mirage.workspace.expand.classify.path import classify_bare_path
from mirage.workspace.mount import MountRegistry


def classify_parts(
    parts: list[str],
    registry: MountRegistry,
    cwd: str,
    word_kinds: list[ValueType | None] | None = None,
    word_bases: list[str | None] | None = None,
) -> list[str | PathSpec]:
    """Classify a list of expanded words.

    First element (command name) is never classified as a path.
    word_kinds (from CommandSpec, aligned with parts[1:]) decides per
    position: TEXT skips classification, PATH classifies even bare
    filenames, None falls back to the shape heuristics. word_bases, also
    aligned with parts[1:], names the directory a word resolves against
    when a chdir option (tar's -C) moved it; None there means the cwd.
    """
    if not parts:
        return []
    result: list[str | PathSpec] = [parts[0]]
    for i, w in enumerate(parts[1:]):
        kind = (word_kinds[i]
                if word_kinds is not None and i < len(word_kinds) else None)
        base = (word_bases[i]
                if word_bases is not None and i < len(word_bases) else None)
        here = base if base is not None else cwd
        if kind is not None and kind != "path":
            result.append(w)
        elif kind == "path":
            result.append(classify_bare_path(w, registry, here))
        else:
            result.append(classify_word(w, registry, here))
    return result
