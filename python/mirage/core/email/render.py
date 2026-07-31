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


def message_json_bytes(message: dict[str, Any]) -> bytes:
    """Render one parsed message as its .email.json body.

    Args:
        message (dict): parsed message dict from ``parse_rfc822``.
    """
    # Single renderer for .email.json: the listing fetches the full message
    # with BODY.PEEK[] and parses it exactly like read() does, so sizing a
    # listed header dict here yields the byte length read() will return.
    return json.dumps(message, ensure_ascii=False,
                      separators=(",", ":")).encode()
