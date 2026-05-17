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

from mirage.core.discord.entry import (channel_dirname, channel_entry,
                                       guild_dirname, guild_entry,
                                       member_entry, member_filename)


def test_guild_dirname_basic():
    assert guild_dirname({"id": "G1", "name": "My Server"}) == "My Server__G1"


def test_guild_dirname_apostrophe_is_preserved():
    assert guild_dirname({
        "id": "G1",
        "name": "Zecheng's Server"
    }) == "Zecheng's Server__G1"


def test_guild_dirname_slash_in_name_is_replaced():
    assert guild_dirname({"id": "G1", "name": "A/B Test"}) == "A∕B Test__G1"


def test_guild_dirname_falls_back_to_unknown_when_name_missing():
    assert guild_dirname({"id": "G1"}) == "unknown__G1"


def test_guild_dirname_falls_back_to_unknown_when_name_empty():
    assert guild_dirname({"id": "G1", "name": ""}) == "unknown__G1"


def test_channel_dirname_basic():
    assert channel_dirname({"id": "C1", "name": "general"}) == "general__C1"


def test_channel_dirname_with_emoji_is_preserved():
    assert channel_dirname({"id": "C1", "name": "🔥-deals"}) == "🔥-deals__C1"


def test_channel_dirname_falls_back_to_unknown():
    assert channel_dirname({"id": "C1"}) == "unknown__C1"


def test_member_filename_basic():
    member = {"user": {"id": "U1", "username": "alice"}}
    assert member_filename(member) == "alice__U1.json"


def test_member_filename_preserves_special_chars():
    member = {"user": {"id": "U1", "username": "bob.smith!"}}
    assert member_filename(member) == "bob.smith!__U1.json"


def test_member_filename_falls_back_to_unknown():
    member = {"user": {"id": "U1"}}
    assert member_filename(member) == "unknown__U1.json"


def test_same_named_members_get_distinct_filenames():
    a = {"user": {"id": "U1", "username": "alice"}}
    b = {"user": {"id": "U2", "username": "alice"}}
    assert member_filename(a) != member_filename(b)
    assert member_filename(a) == "alice__U1.json"
    assert member_filename(b) == "alice__U2.json"


def test_same_named_channels_get_distinct_dirnames():
    a = {"id": "C1", "name": "general"}
    b = {"id": "C2", "name": "general"}
    assert channel_dirname(a) != channel_dirname(b)


def test_same_named_guilds_get_distinct_dirnames():
    a = {"id": "G1", "name": "Test"}
    b = {"id": "G2", "name": "Test"}
    assert guild_dirname(a) != guild_dirname(b)


def test_guild_entry_vfs_name_matches_dirname():
    g = {"id": "G1", "name": "My Server"}
    assert guild_entry(g).vfs_name == guild_dirname(g)


def test_channel_entry_vfs_name_matches_dirname():
    c = {"id": "C1", "name": "general", "last_message_id": "M1"}
    assert channel_entry(c).vfs_name == channel_dirname(c)


def test_member_entry_vfs_name_matches_filename():
    m = {"user": {"id": "U1", "username": "alice"}}
    assert member_entry(m).vfs_name == member_filename(m)
