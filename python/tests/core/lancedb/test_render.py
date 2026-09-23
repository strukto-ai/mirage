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

from mirage.core.lancedb.render import render_card
from mirage.vfs.lancedb.config import LanceDBConfig


def _cfg() -> LanceDBConfig:
    return LanceDBConfig(uri="/tmp/db",
                         id_column="id",
                         title_column="name",
                         blob_column="image_bytes",
                         blob_ext="png",
                         vector_column="vector")


def test_render_card_basic():
    row = {
        "id": 3,
        "name": "a big brown dog",
        "label": "dog",
        "image_bytes": b"PNG-3",
        "vector": [0.1, 0.2],
    }
    out = render_card(row, _cfg()).decode()
    assert out.startswith("# a big brown dog")
    assert "label: dog" in out
    assert "blob: 3.png" in out
    assert "vector" not in out
    assert "PNG-3" not in out


def test_render_card_includes_score():
    row = {"id": 3, "name": "x", "_distance": 0.25}
    out = render_card(row, _cfg()).decode()
    assert "score: 0.2500" in out
