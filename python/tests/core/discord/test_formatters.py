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

from mirage.core.discord.formatters import format_grep_results


def test_format_grep_results_uses_channel_name_when_available():
    msgs = [{
        "timestamp": "2024-04-10T12:34:56.000000+00:00",
        "channel_id": "C1",
        "author": {
            "username": "alice"
        },
        "content": "hello",
    }]
    lines = format_grep_results(msgs,
                                prefix="/discord",
                                guild_dirname="MyGuild",
                                channel_names={"C1": "general"})
    assert lines == [
        "/discord/MyGuild/channels/general/2024-04-10.jsonl:[alice] hello"
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
    lines = format_grep_results(msgs, "/discord", "G", channel_names={})
    assert lines == ["/discord/G/channels/C2/2024-04-10.jsonl:[bob] x"]


def test_format_grep_results_replaces_newlines():
    msgs = [{
        "timestamp": "2024-01-02",
        "channel_id": "C",
        "author": {
            "username": "u"
        },
        "content": "line1\nline2",
    }]
    lines = format_grep_results(msgs, "/discord", "G", channel_names={})
    assert lines == ["/discord/G/channels/C/2024-01-02.jsonl:[u] line1 line2"]
