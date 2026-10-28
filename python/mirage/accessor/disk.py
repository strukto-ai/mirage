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
from mirage.vfs.capacity import StorageUsage


class DiskAccessor(Accessor):
    def __init__(self, root: Path, folder_versions: bool = True) -> None:
        """Args:
        root (Path): the mount root on the host.
        folder_versions (bool): whether a listing is stored with its
            folder's version (``mirage.core.disk.listing_version``).
        """
        self.root = root
        self.folder_versions = folder_versions
        # The root's capacity and counted bytes, None when uncapped.
        self.usage: StorageUsage | None = None

    def forget(self) -> None:
        """Drop its own answers, its count of the root's bytes among them:
        a write past the dispatcher went uncounted."""
        super().forget()
        if self.usage is not None:
            self.usage.stale()
