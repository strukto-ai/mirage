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

from mirage.core.filetype.boxcanvas import process_boxcanvas

_RAW = {
    "board": {
        "id": "board-1"
    },
    "widgets": [
        {
            "id": "w1",
            "userId": "u1",
            "createdTs": 1717200000,
            "lastModifiedTs": 1717200060,
            "lastModifiedBy": "u2",
            "data": {
                "type": "shape",
                "content": {
                    "content": [{
                        "type": "paragraph",
                        "content": [{
                            "type": "text",
                            "text": "Label"
                        }],
                    }]
                },
            },
        },
        {
            "id": "w2",
            "userId": "u1",
            "data": {
                "type": "link"
            },
        },
    ],
}


def test_process_boxcanvas_counts_and_extracts_text():
    out = json.loads(process_boxcanvas(json.dumps(_RAW).encode()))
    assert out["id"] == "board-1"
    assert out["widget_count"] == 2
    assert out["widgets_by_type"] == {"shape": 1, "link": 1}
    assert out["body_text"] == "Label"
    assert out["authors"] == ["u1", "u2"]
    first = out["widgets"][0]
    assert first["id"] == "w1"
    assert first["type"] == "shape"
    assert first["created_at"] == "2024-06-01T00:00:00.000Z"
    assert first["modified_at"] == "2024-06-01T00:01:00.000Z"
    assert first["modified_by"] == "u2"
    assert first["text"] == "Label"


def test_process_boxcanvas_handles_empty_payload():
    out = json.loads(process_boxcanvas(b"{}"))
    assert out == {
        "id": "",
        "widget_count": 0,
        "widgets_by_type": {},
        "body_text": "",
        "widgets": [],
        "authors": [],
    }
