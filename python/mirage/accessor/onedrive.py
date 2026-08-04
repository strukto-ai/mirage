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

from pydantic import model_validator

from mirage.accessor.base import Accessor
from mirage.core.msgraph.config import MsGraphConfig

DRIVE_TARGETS = ("drive_id", "site_id", "group_id", "user_id")


class OneDriveConfig(MsGraphConfig):
    drive_id: str | None = None
    site_id: str | None = None
    # A Teams/Microsoft 365 group's document library, and another user's
    # drive under app-only auth. Both are reachable without first
    # resolving a drive id out of band.
    group_id: str | None = None
    user_id: str | None = None
    key_prefix: str | None = None

    @model_validator(mode="after")
    def _one_drive_target(self) -> "OneDriveConfig":
        """Reject more than one way of naming the drive.

        With four fields and a fixed precedence, setting two would make
        the mount silently address whichever won, which is the kind of
        misconfiguration that only shows up as a confusing 404.
        """
        named = [f for f in DRIVE_TARGETS if getattr(self, f) is not None]
        if len(named) > 1:
            raise ValueError(
                f"OneDriveConfig names {len(named)} drives "
                f"({', '.join(named)}); set exactly one, or none for the "
                "signed-in user's drive")
        return self


class OneDriveAccessor(Accessor):

    def __init__(self, config: OneDriveConfig) -> None:
        self.config = config
