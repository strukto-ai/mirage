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

from pathlib import Path
from typing import Protocol

from dulwich.repo import Repo


class VersionBackend(Protocol):

    def open_repo(self, workspace_id: str) -> Repo:
        ...


class LocalBackend:

    def __init__(self, root: str | Path) -> None:
        self._root = Path(root)

    def open_repo(self, workspace_id: str) -> Repo:
        path = self._root / workspace_id
        if (path / "objects").is_dir():
            return Repo(str(path))
        path.mkdir(parents=True, exist_ok=True)
        return Repo.init_bare(str(path))
