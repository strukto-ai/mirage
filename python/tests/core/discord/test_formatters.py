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

from mirage.core.discord.entry import channel_dirname, guild_dirname
from mirage.core.discord.formatters import format_grep_results


def test_format_grep_results_uses_vfs_channel_dirname():
    msgs = [{
        "timestamp": "2024-04-10T12:34:56.000000+00:00",
        "channel_id": "C1",
        "author": {
            "username": "alice"
        },
        "content": "hello",
    }]
    guild = {"id": "G1", "name": "MyGuild"}
    chan = {"id": "C1", "name": "general"}
    lines = format_grep_results(
        msgs,
        prefix="/discord",
        guild_dirname=guild_dirname(guild),
        channel_names={chan["id"]: channel_dirname(chan)})
    assert lines == [
        "/discord/MyGuild__G1/channels/general__C1/"
        "2024-04-10/chat.jsonl:[alice] hello"
    ]


def test_format_grep_results_falls_back_to_channel_id():
    msgs = [{
        "timestamp": "2024-04-10T00:00:00+00:00",
        "channel_id": "C2",
        "author": {
            "username": "bob"
        },
        "content": "x",
    }]
    lines = format_grep_results(msgs, "/discord", "G__G1", channel_names={})
    assert lines == [
        "/discord/G__G1/channels/C2/2024-04-10/chat.jsonl:[bob] x"
    ]


def test_format_grep_results_path_matches_vfs_layout():
    msgs = [{
        "timestamp": "2024-04-10T00:00:00+00:00",
        "channel_id": "C1",
        "author": {
            "username": "alice"
        },
        "content": "hi",
    }]
    guild = {"id": "G1", "name": "S"}
    chan = {"id": "C1", "name": "general"}
    line = format_grep_results(msgs, "/discord", guild_dirname(guild),
                               {chan["id"]: channel_dirname(chan)})[0]
    expected_path = (f"/discord/{guild_dirname(guild)}/channels/"
                     f"{channel_dirname(chan)}/2024-04-10/chat.jsonl")
    assert line.startswith(expected_path + ":")


def test_format_grep_results_replaces_newlines():
    msgs = [{
        "timestamp": "2024-01-02",
        "channel_id": "C",
        "author": {
            "username": "u"
        },
        "content": "line1\nline2",
    }]
    lines = format_grep_results(msgs, "/discord", "G__G1", channel_names={})
    assert lines == [
        "/discord/G__G1/channels/C/2024-01-02/chat.jsonl:[u] line1 line2"
    ]
