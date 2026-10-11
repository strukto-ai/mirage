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

from mirage.core.discord.scope import detect_scope
from mirage.core.hierarchy.scope import INVALID, ROOT

CHAT = "/My Server__G1/channels/general__C1/2024-01-15/chat.jsonl"


def test_root():
    assert detect_scope("/").kind == ROOT


def test_guild():
    match = detect_scope("/My Server__G1")
    assert match.kind == "guild"
    assert match.slots == {"guild": "My Server", "guild_id": "G1"}


def test_guild_bare_name_is_invalid():
    # The tree mints every dirname as `name__id`, so a bare name can
    # never be a listed guild and classifies as invalid outright.
    assert detect_scope("/My Server").kind == INVALID


def test_containers():
    assert detect_scope("/My Server__G1/channels").kind == "channels_dir"
    assert detect_scope("/My Server__G1/members").kind == "members_dir"
    assert detect_scope("/My Server__G1/nope").kind == INVALID


def test_channel():
    match = detect_scope("/My Server__G1/channels/general__C1")
    assert match.kind == "channel"
    assert match.slots["channel"] == "general"
    assert match.slots["channel_id"] == "C1"


def test_member_json():
    match = detect_scope("/My Server__G1/members/alice__U1.json")
    assert match.kind == "member"
    assert match.slots["member"] == "alice"
    assert match.slots["user_id"] == "U1"


def test_member_without_suffix_is_invalid():
    assert detect_scope("/My Server__G1/members/alice__U1").kind == INVALID


def test_day_dir():
    match = detect_scope("/My Server__G1/channels/general__C1/2024-01-15")
    assert match.kind == "day"
    assert match.slots["day"] == "2024-01-15"


def test_non_date_under_channel_is_invalid():
    assert (
        detect_scope("/My Server__G1/channels/general__C1/notadate").kind
        == INVALID
    )


def test_messages_file():
    match = detect_scope(CHAT)
    assert match.kind == "messages"
    assert match.scope is not None and match.scope.leaf


def test_files_dir():
    assert (
        detect_scope(
            "/My Server__G1/channels/general__C1/2024-01-15/files"
        ).kind
        == "files"
    )


def test_file_blob():
    match = detect_scope(
        "/My Server__G1/channels/general__C1/2024-01-15/files/kept__A1.txt"
    )
    assert match.kind == "file_blob"
    assert match.slots["blob"] == "kept__A1.txt"


def test_deep_unknown_path_is_invalid():
    assert (
        detect_scope(
            "/My Server__G1/channels/general__C1/2024-01-15/files/a/b"
        ).kind
        == INVALID
    )


def test_dot_segment_is_invalid():
    assert detect_scope("/My Server__G1/channels/.hidden__C1").kind == INVALID
