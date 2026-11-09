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

from mirage.commands.cli.builtin.himalaya.envelopes import envelopes_table

ENVELOPE = {
    "id": "7",
    "flags": [{"iana": "answered"}, {"iana": "flagged"}],
    "has-attachment": True,
    "subject": "Hi",
    "from": [{"name": None, "email": "a@b.c"}],
    "to": [{"name": "Dee", "email": "d@e.f"}],
    "date": "2026-01-05T09:30:00+01:00",
    "size": 2048,
}


def _rows(table: str) -> list[list[str]]:
    return [
        [cell.strip() for cell in line.strip("│").split("┆")]
        for line in table.splitlines()
        if line.startswith("│")
    ]


def test_senders_by_default():
    rows = _rows(envelopes_table([ENVELOPE], False, False, None))
    assert rows[0] == ["ID", "FLAGS", "SUBJECT", "FROM", "DATE", "SIZE"]
    assert rows[1][0] == "7"
    assert rows[1][3] == "a@b.c"
    assert rows[1][4] == "2026-01-05 09:30+01:00"
    assert rows[1][5] == "2 KiB"


def test_flag_glyphs_keep_their_columns():
    table = envelopes_table([ENVELOPE], False, False, None)
    assert "*R!" in table
    seen = {**ENVELOPE, "flags": [{"iana": "seen"}]}
    assert _rows(envelopes_table([seen], False, False, None))[1][1] == ""


def test_recipient_and_attachment_columns():
    rows = _rows(envelopes_table([ENVELOPE], True, True, None))
    assert rows[0][2] == "ATT"
    assert rows[1][2] == "@"
    assert rows[0][4] == "TO"
    assert rows[1][4] == "Dee"
