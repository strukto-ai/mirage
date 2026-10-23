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

from mirage.core.google.client import TokenManager, docs_base, google_get
from mirage.core.render.json import compact_json_bytes

TABS_CONTENT_PARAM = "true"


class DocsApi(Protocol):
    """Every Docs request a Google backend makes, as one object.

    A core op reaches Docs only through its accessor's ``docs``, so the
    backend runs against an in-memory Docs wherever another
    implementation is served there.
    """

    async def read_doc(self, doc_id: str) -> bytes: ...


@dataclass(frozen=True, slots=True)
class DocsClient:
    """The live ``DocsApi``: one token manager, one wire call per
    method."""

    token_manager: TokenManager

    async def read_doc(self, doc_id: str) -> bytes:
        """Fetch full document JSON, every tab included.

        `documents.get` fills the singleton fields from the first tab and
        leaves `tabs` empty unless asked otherwise, so without
        `includeTabsContent` a multi-tab document renders as tab 1 and the
        rest are absent rather than truncated. Asking for it moves the
        content under `tabs[]` and leaves `body` empty, which is the shape
        the VFS prompt documents.

        Args:
            doc_id (str): Google Docs document ID.

        Returns:
            bytes: JSON response as bytes.
        """
        url = f"{docs_base(self.token_manager)}/documents/{doc_id}"
        data = await google_get(
            self.token_manager,
            url,
            params={"includeTabsContent": TABS_CONTENT_PARAM},
        )
        return compact_json_bytes(data)
