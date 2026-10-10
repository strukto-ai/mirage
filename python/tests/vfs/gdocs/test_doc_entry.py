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


from mirage.vfs.gdocs.doc_entry import DocEntry, make_filename


def test_doc_entry_creation():
    entry = DocEntry(
        id="abc123",
        name="My Doc",
        modified_time="2026-04-01T12:00:00.000Z",
        created_time="2026-03-01T12:00:00.000Z",
        owner="user@gmail.com",
        owned_by_me=True,
        can_edit=True,
        filename="My_Doc__abc123.gdoc.json",
    )
    assert entry.id == "abc123"
    assert entry.name == "My Doc"
    assert entry.owned_by_me is True
    assert entry.can_edit is True
    assert entry.filename == "My_Doc__abc123.gdoc.json"


def test_make_filename_names_a_document():
    assert make_filename("My Doc", "abc123") == "My_Doc__abc123.gdoc.json"
    f1 = make_filename("My Doc", "abc123", "2026-04-01T00:00:00.000Z")
    f2 = make_filename("My Doc", "def456", "2026-03-15T00:00:00.000Z")
    assert f1 == "2026-04-01_My_Doc__abc123.gdoc.json"
    assert f2 == "2026-03-15_My_Doc__def456.gdoc.json"
