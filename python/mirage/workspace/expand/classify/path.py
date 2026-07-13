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

from mirage.types import PathSpec
from mirage.workspace.expand.classify.heuristic import classify_word
from mirage.workspace.expand.classify.relative import relative_spec
from mirage.workspace.mount import MountRegistry


def classify_bare_path(word: str, registry: MountRegistry,
                       cwd: str) -> str | PathSpec:
    """Classify a bare filename as a path resolved against cwd.

    Used when CommandSpec identifies an arg as PATH but classify_word
    would not classify it (e.g. bare "file.txt" without "/" prefix).
    """
    classified = classify_word(word, registry, cwd)
    if not isinstance(classified, str):
        return classified
    return relative_spec(word, registry, cwd)
