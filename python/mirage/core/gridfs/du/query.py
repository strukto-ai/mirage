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

import re
from typing import Any


def subtree_query(stem: str) -> dict[str, Any]:
    """Match the file at ``stem`` plus everything beneath it.

    Args:
        stem (str): backend key with no trailing slash.
    """
    if not stem:
        return {}
    return {
        "$or": [
            {
                "filename": stem
            },
            {
                "filename": {
                    "$regex": "^" + re.escape(stem + "/")
                }
            },
        ]
    }
