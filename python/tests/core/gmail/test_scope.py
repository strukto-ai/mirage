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

from mirage.core.gmail.scope import detect_scope
from mirage.core.hierarchy.scope import INVALID, ROOT


def test_root():
    match = detect_scope("/")
    assert match.kind == ROOT


def test_label_dir():
    match = detect_scope("/INBOX")
    assert match.kind == "label"
    assert match.slots == {"label": "INBOX"}


def test_day_dir():
    match = detect_scope("/INBOX/2026-04-12")
    assert match.kind == "day"
    assert match.slots == {"label": "INBOX", "day": "2026-04-12"}


def test_non_date_under_label_is_invalid():
    assert detect_scope("/INBOX/notadate").kind == INVALID


def test_message_file():
    match = detect_scope("/INBOX/2026-04-12/Test_Email__msg1.gmail.json")
    assert match.kind == "message"
    assert match.slots["message"] == "Test_Email"
    assert match.slots["message_id"] == "msg1"


def test_attachment_dir():
    match = detect_scope("/INBOX/2026-04-12/Test_Email__msg1")
    assert match.kind == "attachment_dir"
    assert match.slots["message_id"] == "msg1"


def test_attachment_file():
    match = detect_scope("/INBOX/2026-04-12/Test_Email__msg1/report.pdf")
    assert match.kind == "attachment"
    assert match.slots["message_id"] == "msg1"
    assert match.slots["filename"] == "report.pdf"


def test_bare_name_at_message_depth_is_invalid():
    # Without the `__id` half the segment can be neither a message file
    # nor an attachment dir.
    assert detect_scope("/INBOX/2026-04-12/loose-file").kind == INVALID


def test_deep_unknown_path_is_invalid():
    assert detect_scope("/INBOX/2026-04-12/A__m1/b/c").kind == INVALID
