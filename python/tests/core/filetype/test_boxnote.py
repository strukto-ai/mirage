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

from mirage.core.filetype.boxnote import process_boxnote

_RAW = {
    "doc": {
        "content": [
            {
                "type":
                "paragraph",
                "content": [{
                    "type":
                    "text",
                    "text":
                    "First line",
                    "marks": [{
                        "type": "author_id",
                        "attrs": {
                            "authorId": "u1"
                        }
                    }],
                }],
            },
            {
                "type":
                "paragraph",
                "content": [{
                    "type":
                    "text",
                    "text":
                    "Second line",
                    "marks": [{
                        "type": "author_id",
                        "attrs": {
                            "authorId": "u2"
                        }
                    }],
                }],
            },
        ]
    },
    "savepoint_metadata": {
        "savepointFileId": "note-1",
        "allAuthorNames": {
            "u1": "Alice",
            "u2": "Bob"
        },
    },
    "last_edit_timestamp": 1717200000000,
}


def test_process_boxnote_extracts_body_and_authors():
    out = json.loads(process_boxnote(json.dumps(_RAW).encode()))
    assert out["id"] == "note-1"
    assert out["body_text"] == "First line\nSecond line"
    assert out["paragraphs"] == [
        {
            "text": "First line",
            "authors": ["u1"]
        },
        {
            "text": "Second line",
            "authors": ["u2"]
        },
    ]
    assert out["authors"] == {"u1": "Alice", "u2": "Bob"}
    assert out["last_edit_at"] == "2024-06-01T00:00:00.000Z"


def test_process_boxnote_handles_empty_doc():
    out = json.loads(process_boxnote(b"{}"))
    assert out == {
        "id": "",
        "body_text": "",
        "paragraphs": [],
        "authors": {},
        "last_edit_at": "",
    }
