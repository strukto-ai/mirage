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

from mirage.accessor.base import Accessor


class DiskAccessor(Accessor):

    def __init__(self,
                 root: Path,
                 attrs: dict[str, dict] | None = None) -> None:
        self.root = root
        # Per-path metadata sidecar (mode/uid/gid/atime); mode is also
        # applied to the real inode, but stat reports the sidecar value so
        # output stays deterministic across host umasks.
        self.attrs: dict[str, dict] = attrs if attrs is not None else {}
