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

from mirage.core.hierarchy.scope import INVALID, ROOT
from mirage.core.slack.scope import (
    NATIVE_KINDS,
    SearchTarget,
    detect_scope,
    search_target,
)


def test_root():
    match = detect_scope("/")
    assert match.kind == ROOT
    assert ROOT in NATIVE_KINDS


def test_containers():
    assert detect_scope("/channels").kind == "channels_root"
    assert detect_scope("/dms").kind == "dms_root"
    assert detect_scope("/users").kind == "users_root"


def test_channel_dir():
    match = detect_scope("/channels/general__C001")
    assert match.kind == "channel"
    assert match.slots == {
        "container": "channels",
        "channel": "general",
        "channel_id": "C001",
    }


def test_dm_dir():
    match = detect_scope("/dms/alice__D001")
    assert match.kind == "channel"
    assert match.slots["container"] == "dms"
    assert match.slots["channel_id"] == "D001"


def test_channel_bare_name_is_invalid():
    # The tree mints every dirname as `name__id`, so a bare name can
    # never be a listed channel and classifies as invalid outright.
    assert detect_scope("/channels/general").kind == INVALID


def test_user_file():
    match = detect_scope("/users/alice__U001.json")
    assert match.kind == "user"
    assert match.slots == {"user": "alice", "user_id": "U001"}
    assert "user" not in NATIVE_KINDS


def test_day_dir():
    match = detect_scope("/channels/general__C001/2024-04-10")
    assert match.kind == "day"
    assert match.slots["day"] == "2024-04-10"
    assert "day" not in NATIVE_KINDS


def test_non_date_under_channel_is_invalid():
    assert detect_scope("/channels/general__C001/notadate").kind == INVALID


def test_chat_jsonl():
    match = detect_scope("/channels/general__C001/2024-04-10/chat.jsonl")
    assert match.kind == "messages"
    assert "messages" not in NATIVE_KINDS


def test_files_dir_is_not_native():
    match = detect_scope("/channels/general__C001/2024-04-10/files")
    assert match.kind == "files"
    # search.files has no per-day filter, so the files dir takes the scan.
    assert "files" not in NATIVE_KINDS


def test_file_blob():
    match = detect_scope("/dms/bob__D001/2024-04-10/files/report__F1.pdf")
    assert match.kind == "file_blob"
    assert match.slots["blob"] == "report__F1.pdf"
    assert "file_blob" not in NATIVE_KINDS


def test_unknown_root_is_invalid():
    assert detect_scope("/nope").kind == INVALID
    assert detect_scope("/nope/deeper").kind == INVALID


def test_search_target_from_channel():
    match = detect_scope("/channels/general__C001/2024-04-10")
    assert search_target(match) == SearchTarget(
        container="channels", channel_name="general", channel_id="C001"
    )


def test_search_target_from_container_root():
    assert search_target(detect_scope("/dms")) == SearchTarget(container="dms")


def test_search_target_from_root_is_workspace_wide():
    assert search_target(detect_scope("/")) == SearchTarget()
