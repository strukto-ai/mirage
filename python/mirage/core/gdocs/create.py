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

from typing import Any

from mirage.core.gdocs._client import DOCS_API_BASE, TokenManager, google_post


async def create_doc(token_manager: TokenManager,
                     title: str) -> dict[str, Any]:
    """Create a new empty Google Doc with a title.

    Args:
        token_manager (TokenManager): manages OAuth2 tokens.
        title (str): document title.

    Returns:
        dict: API response with documentId, title, etc.
    """
    url = f"{DOCS_API_BASE}/documents"
    return await google_post(token_manager, url, {"title": title})
