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

from mirage.core.linear.pathing import (
    cycle_filename,
    document_filename,
    issue_dirname,
    member_filename,
    project_filename,
    split_suffix_id,
    team_dirname,
)
from mirage.utils.sanitize import NAME_MAX_BYTES, byte_length


def test_split_suffix_id_basic():
    label, obj_id = split_suffix_id("ENG__Engineering__TEAM1")
    assert label == "ENG__Engineering"
    assert obj_id == "TEAM1"


def test_split_suffix_id_with_suffix():
    label, obj_id = split_suffix_id("Alice__USER1.json", suffix=".json")
    assert label == "Alice"
    assert obj_id == "USER1"


def test_split_suffix_id_missing_suffix():
    with pytest.raises(FileNotFoundError):
        split_suffix_id("Alice__USER1.json", suffix=".txt")


def test_split_suffix_id_no_separator():
    with pytest.raises(FileNotFoundError):
        split_suffix_id("noseparator")


def test_team_dirname():
    team = {"id": "TEAM1", "key": "ENG", "name": "Engineering"}
    assert team_dirname(team) == "ENG__Engineering__TEAM1"


def test_team_dirname_same_key_and_name():
    team = {"id": "TEAM1", "key": "ENG", "name": "ENG"}
    assert team_dirname(team) == "ENG__TEAM1"


def test_team_dirname_no_key():
    team = {"id": "TEAM1", "name": "Engineering"}
    assert team_dirname(team) == "Engineering__TEAM1"


def test_member_filename():
    user = {"id": "USER1", "name": "Alice", "displayName": "Alice"}
    assert member_filename(user) == "Alice__USER1.json"


def test_member_filename_display_name_preferred():
    user = {"id": "USER1", "name": "alice_w", "displayName": "Alice W"}
    assert member_filename(user) == "Alice_W__USER1.json"


def test_issue_dirname():
    issue = {"id": "ISSUE1", "identifier": "ENG-123"}
    assert issue_dirname(issue) == "ENG-123__ISSUE1"


def test_issue_dirname_no_identifier():
    issue = {"id": "ISSUE1"}
    assert issue_dirname(issue) == "ISSUE1__ISSUE1"


def test_project_filename():
    project = {"id": "PROJ1", "name": "Agent Data Plane"}
    assert project_filename(project) == "Agent_Data_Plane__PROJ1.json"


def test_cycle_filename():
    cycle = {"id": "CYCLE1", "name": "Sprint 1"}
    assert cycle_filename(cycle) == "Sprint_1__CYCLE1.json"


def test_cycle_filename_no_name():
    cycle = {"id": "CYCLE1"}
    assert cycle_filename(cycle) == "cycle__CYCLE1.json"


CJK = "会議の記録" * 40
UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6"

# Every builder, the record fields it reads for the label, and the suffix it
# appends.
NAME_CASES = [
    (team_dirname, ("key", "name"), ""),
    (member_filename, ("displayName",), ".json"),
    (issue_dirname, ("identifier",), ""),
    (project_filename, ("name",), ".json"),
    (cycle_filename, ("name",), ".json"),
    (document_filename, ("title",), ".json"),
]


@pytest.mark.parametrize("build,fields,suffix", NAME_CASES)
def test_a_cjk_label_fits_name_max_and_still_addresses_the_id(
    build, fields, suffix
):
    # These composed `<label>__<id>` by hand, so the 100-character cap in
    # sanitize_name let a CJK name render 338-343 bytes against a 255-byte
    # NAME_MAX. They route through fit_id_name now.
    record: dict[str, str] = {"id": UUID}
    for field in fields:
        record[field] = CJK
    name = build(record)
    assert byte_length(name) <= NAME_MAX_BYTES
    assert "\ufffd" not in name
    assert split_suffix_id(name, suffix=suffix)[1] == UUID


def test_team_dirname_keeps_the_separator_between_its_parts():
    # The label is two sanitized parts joined by `__`; re-sanitizing it
    # would collapse that to `_` and change the directory's name.
    assert (
        team_dirname({"key": "ENG", "name": "Engineering", "id": "T1"})
        == "ENG__Engineering__T1"
    )
