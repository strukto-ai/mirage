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


from mirage.vfs.gsheets.sheet_entry import SheetEntry, make_filename


def test_sheet_entry_creation():
    entry = SheetEntry(
        id="abc123",
        name="My Spreadsheet",
        modified_time="2026-04-01T12:00:00.000Z",
        created_time="2026-03-01T12:00:00.000Z",
        owner="user@gmail.com",
        owned_by_me=True,
        can_edit=True,
        filename="My_Spreadsheet__abc123.gsheet.json",
    )
    assert entry.id == "abc123"
    assert entry.owned_by_me is True
    assert entry.can_edit is True


def test_make_filename_with_and_without_a_date():
    assert (
        make_filename("My Spreadsheet", "abc123", "2026-03-15T10:00:00Z")
        == "2026-03-15_My_Spreadsheet__abc123.gsheet.json"
    )
    assert (
        make_filename("My Spreadsheet", "abc123")
        == "My_Spreadsheet__abc123.gsheet.json"
    )
