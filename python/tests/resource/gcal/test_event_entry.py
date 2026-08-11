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

from mirage.resource.gcal.event_entry import (PRIMARY_DIR, event_title,
                                              make_calendar_dirname,
                                              make_event_filename,
                                              parse_calendar_dirname,
                                              parse_event_filename)
from mirage.utils.sanitize import NAME_MAX_BYTES

EVENT_ID = "la9i1t995acovthi3f761chla0"


def test_filename_leads_with_the_id():
    name = make_event_filename(EVENT_ID, "0900-1030", "PhD_Defense")
    assert name == f"{EVENT_ID}__0900-1030_PhD_Defense.gcal.json"
    assert parse_event_filename(name) == (EVENT_ID, "0900-1030")


def test_filename_round_trips_a_title_holding_underscores():
    name = make_event_filename(EVENT_ID, "1500-1600", "A__B_C")
    assert parse_event_filename(name) == (EVENT_ID, "1500-1600")


def test_filename_rejects_a_non_event_name():
    with pytest.raises(FileNotFoundError):
        parse_event_filename("notes.txt")
    with pytest.raises(FileNotFoundError):
        parse_event_filename("noseparator.gcal.json")
    with pytest.raises(FileNotFoundError):
        parse_event_filename(f"{EVENT_ID}__090.gcal.json")


def test_long_ascii_title_is_trimmed_to_name_max():
    name = make_event_filename(EVENT_ID, "0900-1030", "a" * 400)
    assert len(name.encode()) <= NAME_MAX_BYTES
    assert parse_event_filename(name) == (EVENT_ID, "0900-1030")


def test_long_cjk_title_is_trimmed_by_bytes_not_characters():
    # 3 bytes per character: a character-counted budget would overflow
    # NAME_MAX, which is the bug gdocs' sanitize_title still has.
    name = make_event_filename(EVENT_ID, "0900-1030", "会" * 200)
    raw = name.encode()
    assert len(raw) <= NAME_MAX_BYTES
    assert raw.decode() == name
    assert parse_event_filename(name) == (EVENT_ID, "0900-1030")


def test_title_is_dropped_when_a_long_id_leaves_no_room():
    # 234 is the widest id that still names an event: the title is squeezed
    # out entirely and id + separators + suffix lands exactly on NAME_MAX.
    long_id = "v" * 234
    name = make_event_filename(long_id, "0900-1030", "Some_Title")
    assert len(name.encode()) == NAME_MAX_BYTES
    assert name == f"{long_id}__0900-1030.gcal.json"
    assert parse_event_filename(name) == (long_id, "0900-1030")


def test_an_id_too_long_to_name_keeps_the_id_rather_than_truncating_it():
    # The title is what gives, never the id: a trimmed id would stop
    # addressing the event. Real Google ids are 26 chars, so this only
    # arises for a caller-supplied events.import id.
    long_id = "v" * (NAME_MAX_BYTES - 20)
    name = make_event_filename(long_id, "0900-1030", "Some Title")
    assert len(name.encode()) > NAME_MAX_BYTES
    assert parse_event_filename(name) == (long_id, "0900-1030")


def test_event_title_falls_back_by_access_role():
    assert event_title("Standup") == "Standup"
    assert event_title(None) == "untitled"
    assert event_title("   ") == "untitled"
    assert event_title(None, free_busy=True) == "busy"


def test_primary_calendar_keeps_its_alias():
    assert make_calendar_dirname("integ@example.com",
                                 "integ@example.com",
                                 primary=True) == PRIMARY_DIR
    assert parse_calendar_dirname(PRIMARY_DIR) == PRIMARY_DIR


def test_calendar_dirname_embeds_the_id_verbatim():
    cal_id = "en.usa#holiday@group.v.calendar.google.com"
    name = make_calendar_dirname("US Holidays", cal_id)
    assert name == f"US_Holidays__{cal_id}"
    assert parse_calendar_dirname(name) == cal_id


def test_calendar_dirname_rejects_a_name_without_an_id():
    with pytest.raises(FileNotFoundError):
        parse_calendar_dirname("Engineering")
