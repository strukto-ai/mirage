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
import logging

import pytest

from mirage.core.dropbox.fingerprint import result_token


@pytest.mark.parametrize(
    "raw, token, warns",
    [
        (
            json.dumps({"server_modified": "t", "content_hash": "h"}),
            "h",
            False,
        ),
        (None, None, False),
        (json.dumps({"server_modified": "t"}), None, False),
        (json.dumps({"content_hash": ""}), None, False),
        (json.dumps({"content_hash": 7}), None, False),
        ("not json", None, True),
        (json.dumps(["a"]), None, True),
    ],
    ids=[
        "hash",
        "absent",
        "no-hash",
        "empty-hash",
        "number-hash",
        "not-json",
        "not-object",
    ],
)
def test_a_result_header_names_its_content_hash(raw, token, warns, caplog):
    # Never the modified stamp: stat stamps content_hash. Dropbox always
    # sends a JSON object, so anything else warns.
    with caplog.at_level(logging.WARNING, logger="mirage.core.dropbox"):
        assert result_token(raw) == token
    assert ("Dropbox-API-Result" in caplog.text) is warns
