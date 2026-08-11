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

import json
from typing import Any


def json_bytes(data: dict[str, Any]) -> bytes:
    """Render one document as an indented .json body.

    Args:
        data (dict): the document to render.
    """
    return json.dumps(data, ensure_ascii=False, indent=2).encode()


def jsonl_bytes(items: list[dict[str, Any]]) -> bytes:
    """Render documents as line-delimited JSON.

    Args:
        items (list[dict]): the documents to render, in order.
    """
    # Single renderer for every .jsonl path: read() and the readdir-time
    # sizing must produce the same bytes for the same rows, so the
    # advertised size is exact by construction.
    if not items:
        return b""
    lines = [
        json.dumps(item, ensure_ascii=False, separators=(",", ":"))
        for item in items
    ]
    return ("\n".join(lines) + "\n").encode()
