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

from dataclasses import dataclass
from typing import Protocol

from mirage.core.google.client import TokenManager, google_get, slides_base
from mirage.core.render.json import compact_json_bytes


class SlidesApi(Protocol):
    """Every Slides request a Google backend makes, as one object.

    A core op reaches Slides only through its accessor's ``slides``, so
    the backend runs against an in-memory Slides wherever another
    implementation is served there.
    """

    async def read_presentation(self, presentation_id: str) -> bytes: ...


@dataclass(frozen=True, slots=True)
class SlidesClient:
    """The live ``SlidesApi``: one token manager, one wire call per
    method."""

    token_manager: TokenManager

    async def read_presentation(self, presentation_id: str) -> bytes:
        """Fetch presentation JSON.

        Args:
            presentation_id (str): Google Slides presentation ID.

        Returns:
            bytes: JSON response as bytes.
        """
        base = slides_base(self.token_manager)
        data = await google_get(
            self.token_manager, f"{base}/presentations/{presentation_id}"
        )
        return compact_json_bytes(data)
