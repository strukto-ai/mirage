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

import pytest

from mirage.core.trello.pathing import (
    board_dirname,
    card_dirname,
    label_filename,
    list_dirname,
    member_filename,
    split_suffix_id,
    workspace_dirname,
)
from mirage.utils.sanitize import NAME_MAX_BYTES, byte_length


def test_split_suffix_id():
    label, obj_id = split_suffix_id("my-board__abc123")
    assert label == "my-board"
    assert obj_id == "abc123"


def test_split_suffix_id_with_suffix():
    label, obj_id = split_suffix_id("alice__user1.json", suffix=".json")
    assert label == "alice"
    assert obj_id == "user1"


def test_split_suffix_id_no_separator():
    with pytest.raises(FileNotFoundError):
        split_suffix_id("no-separator")


def test_workspace_dirname():
    ws = {"id": "ws1", "displayName": "Engineering", "name": "eng"}
    assert workspace_dirname(ws) == "Engineering__ws1"


def test_board_dirname():
    board = {"id": "b1", "name": "Product Roadmap"}
    assert board_dirname(board) == "Product_Roadmap__b1"


def test_list_dirname():
    lst = {"id": "l1", "name": "Backlog"}
    assert list_dirname(lst) == "Backlog__l1"


def test_card_dirname():
    card = {"id": "c1", "name": "Fix login"}
    assert card_dirname(card) == "Fix_login__c1"


def test_member_filename():
    member = {"id": "m1", "fullName": "Alice Smith", "username": "alice"}
    assert member_filename(member) == "Alice_Smith__m1.json"


def test_label_filename():
    label = {"id": "lb1", "name": "bug", "color": "red"}
    assert label_filename(label) == "bug__lb1.json"


def test_label_filename_no_name():
    label = {"id": "lb1", "name": "", "color": "red"}
    assert label_filename(label) == "red__lb1.json"


CJK = "会議の記録" * 40
HEX24 = "5f2a9b1c3d4e5f6a7b8c9d0e"

# Every builder, the record fields it reads for the label, and the suffix it
# appends.
NAME_CASES = [
    (workspace_dirname, ("displayName",), ""),
    (board_dirname, ("name",), ""),
    (list_dirname, ("name",), ""),
    (card_dirname, ("name",), ""),
    (member_filename, ("fullName",), ".json"),
    (label_filename, ("name",), ".json"),
]


@pytest.mark.parametrize("build,fields,suffix", NAME_CASES)
def test_a_cjk_label_fits_name_max_and_still_addresses_the_id(
    build, fields, suffix
):
    # These composed `<label>__<id>` by hand, so the 100-character cap in
    # sanitize_name let a CJK name render 326-331 bytes against a 255-byte
    # NAME_MAX. They route through fit_id_name now.
    record: dict[str, str] = {"id": HEX24}
    for field in fields:
        record[field] = CJK
    name = build(record)
    assert byte_length(name) <= NAME_MAX_BYTES
    assert "\ufffd" not in name
    assert split_suffix_id(name, suffix=suffix)[1] == HEX24
