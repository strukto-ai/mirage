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

from mirage.utils.sanitize import NAME_MAX_BYTES, byte_len
from mirage.vfs.gdocs.doc_entry import DocEntry, make_filename, sanitize_title

TITLE_MAX = 100


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


def test_sanitize_title_basic():
    assert sanitize_title("Hello World") == "Hello_World"


def test_sanitize_title_special_chars():
    assert sanitize_title("My/Doc: A\\Test") == "My_Doc_A_Test"


def test_sanitize_title_truncation():
    long_title = "A" * 150
    result = sanitize_title(long_title)
    assert len(result) <= TITLE_MAX
    assert result.endswith("...")


def test_sanitize_title_consecutive_underscores():
    assert sanitize_title("Hello   //  World") == "Hello_World"


def test_sanitize_title_empty():
    assert sanitize_title("") == "Untitled"


def test_make_filename_without_date():
    assert make_filename("My Doc", "abc123") == "My_Doc__abc123.gdoc.json"


def test_make_filename_with_date():
    result = make_filename("My Doc", "abc123", "2026-04-01T12:00:00.000Z")
    assert result == "2026-04-01_My_Doc__abc123.gdoc.json"


def test_make_filename_long_title():
    long_title = "A" * 150
    filename = make_filename(long_title, "abc123", "2026-04-01T00:00:00.000Z")
    assert filename.endswith("__abc123.gdoc.json")
    assert filename.startswith("2026-04-01_")


def test_make_filename_duplicate_titles_different_dates():
    f1 = make_filename("My Doc", "abc123", "2026-04-01T00:00:00.000Z")
    f2 = make_filename("My Doc", "def456", "2026-03-15T00:00:00.000Z")
    assert f1 != f2
    assert f1 == "2026-04-01_My_Doc__abc123.gdoc.json"
    assert f2 == "2026-03-15_My_Doc__def456.gdoc.json"


# A real Google file id is 44 characters, so this is the fixed overhead a
# title actually has to fit inside.
DOC_ID = "1" * 44


def test_make_filename_fits_name_max_for_a_cjk_title():
    # 100 characters of CJK is 300 bytes, which the character budget passed
    # untouched: with the date, the id and the suffix the name came to 367
    # bytes and ext4/APFS reject it with ENAMETOOLONG.
    name = make_filename("会議の記録" * 40, DOC_ID, "2026-08-20T12:00:00Z")
    assert byte_len(name) <= NAME_MAX_BYTES
    assert name.startswith("2026-08-20_")
    assert name.endswith(f"__{DOC_ID}.gdoc.json")
    # The cut lands on a character boundary, never mid-sequence.
    assert "\ufffd" not in name


def test_make_filename_leaves_an_ascii_title_on_the_char_budget():
    name = make_filename("a" * 400, DOC_ID, "")
    assert byte_len(name) <= NAME_MAX_BYTES
    assert name == f"{'a' * 97}...__{DOC_ID}.gdoc.json"


def test_make_filename_keeps_the_id_when_it_leaves_no_room():
    # The title is what gives, never the id: a trimmed id would stop
    # addressing the document. Same rule as gcal's event filenames.
    long_id = "v" * (NAME_MAX_BYTES - 4)
    name = make_filename("Some Title", long_id, "")
    assert f"__{long_id}.gdoc.json" in name
