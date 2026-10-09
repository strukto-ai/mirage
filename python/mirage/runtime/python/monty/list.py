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

from pathlib import PurePosixPath


def child_paths(path: PurePosixPath, names: list[str]) -> list[PurePosixPath]:
    """A listing's entries as the guest's paths, sorted as pathlib sorts.

    Backends spell entries differently (bare names, slash-marked
    directories, full paths); joining each onto the directory takes all
    three to one path.

    Args:
        path (PurePosixPath): the directory listed.
        names (list[str]): the entries as the file adapter returned them.
    """
    return sorted({path / name.rstrip("/") for name in names})
