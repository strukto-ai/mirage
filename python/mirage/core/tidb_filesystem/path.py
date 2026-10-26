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
from mirage.vfs.tidb_filesystem.config import TiDBFilesystemConfig


def backend_path(config: TiDBFilesystemConfig, path: str | PathSpec) -> str:
    raw = path.mount_path if isinstance(path, PathSpec) else path
    parts = [part for part in raw.split("/") if part and part != "."]
    if ".." in parts:
        raise ValueError(f"path escapes TiDB file system root: {raw}")
    if not parts:
        return config.root_path
    return config.root_path.rstrip("/") + "/" + "/".join(parts)
