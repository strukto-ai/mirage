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

import base64
from typing import Any

from mirage.core.qdrant.fields import field_value, without_field
from mirage.core.render.json import compact_json_text
from mirage.resource.qdrant.config import QdrantConfig
from mirage.types import JsonValue

_SKIP_KEYS = {"_distance", "_rowid", "_score"}


def blob_bytes(value: JsonValue) -> bytes:
    if isinstance(value, bytes):
        return value
    if isinstance(value, str):
        return base64.b64decode(value)
    raise ValueError("blob column is not bytes or base64 str")


def render_json(row: dict[str, Any], config: QdrantConfig) -> bytes:
    data = {key: value for key, value in row.items() if key not in _SKIP_KEYS}
    data = without_field(data, config.vector_field)
    data = without_field(data, config.blob_field)
    return (compact_json_text(data) + "\n").encode()


def render_text(row: dict[str, Any], config: QdrantConfig) -> bytes:
    value = field_value(row, config.text_field)
    if value is None:
        return b""
    return (str(value) + "\n").encode()
