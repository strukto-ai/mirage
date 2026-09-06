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

from mirage.accessor.base import Accessor
from mirage.core.gdrive.api import DriveApi, drive_api
from mirage.core.google.client import TokenManager


class GDriveAccessor(Accessor):

    # Memoized by core.gdrive.resolve.root_context: the scoped root's
    # shared drive id (None when the root is in My Drive). Unset until
    # the first resolution.
    root_drive_id: str | None

    def __init__(self, config, token_manager: TokenManager) -> None:
        self.config = config
        self.token_manager = token_manager

    @property
    def drive(self) -> DriveApi:
        """The single door every gdrive core op reaches Drive through.

        Built per read rather than memoized in ``__init__``: an embedding
        program constructs the resource (and with it this accessor) before
        a test installs a fake, and a door built once at construction time
        would already point at the live API by then. Building one is a
        frozen dataclass holding the token manager, so it costs nothing
        beside the request it is about to make.
        """
        return drive_api(self.token_manager)
