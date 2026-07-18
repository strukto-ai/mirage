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

from mirage.core.gdocs._client import TokenManager, docs_base, google_post


async def append_text(
    token_manager: TokenManager,
    doc_id: str,
    text: str,
) -> dict[str, Any]:
    """Append text to the end of a Google Doc.

    Args:
        token_manager (TokenManager): manages OAuth2 tokens.
        doc_id (str): Google Docs document ID.
        text (str): plain text to append.

    Returns:
        dict: batchUpdate API response.
    """
    payload = {
        "requests": [{
            "insertText": {
                "text": text,
                "endOfSegmentLocation": {
                    "segmentId": ""
                },
            }
        }]
    }
    url = f"{docs_base(token_manager)}/documents/{doc_id}:batchUpdate"
    return await google_post(token_manager, url, payload)
