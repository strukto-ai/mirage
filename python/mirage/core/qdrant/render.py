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

from mirage.resource.qdrant.config import QdrantConfig

_SKIP_KEYS = {"_distance", "_rowid", "_score"}


def render_json(row: dict[str, Any], config: QdrantConfig) -> bytes:
    data = {
        key: value
        for key, value in row.items() if key not in _SKIP_KEYS
        and key != config.vector_field and key != config.blob_field
    }
    return (json.dumps(data, separators=(",", ":"), ensure_ascii=False) +
            "\n").encode()


def render_text(row: dict[str, Any], config: QdrantConfig) -> bytes:
    value = row.get(config.text_field) if config.text_field else None
    if value is None:
        return b""
    return (str(value) + "\n").encode()
