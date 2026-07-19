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

from typing import TYPE_CHECKING

from mirage.accessor.base import Accessor

if TYPE_CHECKING:
    from mirage.core.dropbox._client import DropboxTokenManager
    from mirage.resource.dropbox.config import DropboxConfig


def normalize_dropbox_root_path(value: str | None) -> str:
    """Normalize a subfolder-mount root to the Dropbox API convention.

    ``''`` for the account root (the API rejects ``'/'``), otherwise
    ``/seg/seg`` with no trailing slash.

    Args:
        value (str | None): configured root path in any slash spelling.
    """
    parts = [p for p in (value or "").split("/") if p not in ("", ".")]
    if ".." in parts:
        raise ValueError("root_path must not contain '..' segments")
    return "/" + "/".join(parts) if parts else ""


class DropboxAccessor(Accessor):

    def __init__(self, config: "DropboxConfig",
                 token_manager: "DropboxTokenManager") -> None:
        self.config = config
        self.token_manager = token_manager
        self.root_path = normalize_dropbox_root_path(config.root_path)
