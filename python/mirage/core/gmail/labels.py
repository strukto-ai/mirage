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

from mirage.core.google._client import TokenManager, gmail_base, google_get


async def list_labels(token_manager: TokenManager) -> list[dict[str, Any]]:
    """List all Gmail labels.

    Args:
        token_manager (TokenManager): manages OAuth2 tokens.

    Returns:
        list[dict]: list of label objects.
    """
    url = f"{gmail_base(token_manager)}/users/me/labels"
    data = await google_get(token_manager, url)
    return data.get("labels", [])
