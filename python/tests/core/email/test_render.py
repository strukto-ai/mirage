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

from mirage.core.email.render import message_json_bytes

MESSAGE = {
    "from": {
        "name": "Alice",
        "email": "alice@example.com"
    },
    "subject": "Hello",
    "date": "",
    "body_text": "hi there",
    "uid": "101",
    "flags": [],
    "internal_date": "07-Aug-2026 20:54:05 +0000",
}


def test_internaldate_is_not_part_of_the_rendered_message():
    body = json.loads(message_json_bytes(MESSAGE))
    assert "internal_date" not in body
    assert body["uid"] == "101"
    assert body["date"] == ""


def test_rendering_is_stable_whether_or_not_internaldate_is_present():
    # readdir sizes a listed message with this renderer and read() serves
    # it with the same one, so the two must agree byte for byte.
    without = {k: v for k, v in MESSAGE.items() if k != "internal_date"}
    assert message_json_bytes(MESSAGE) == message_json_bytes(without)
