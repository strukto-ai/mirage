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

from mirage.core.history.render import (
    render_bash_history,
    render_history_listing,
)


def test_render_bash_history_gnu_format():
    events = [
        {
            "type": "command",
            "session": "s1",
            "timestamp": 1718000000000,
            "command": "ls /data",
        },
        {
            "type": "command",
            "session": "s2",
            "timestamp": 1718000001000,
            "command": "cat /data/a.txt",
        },
    ]
    text = render_bash_history(events)
    assert text == "#1718000000\nls /data\n#1718000001\ncat /data/a.txt\n"


def test_render_bash_history_ignores_non_command_events():
    events = [
        {"type": "clear", "session": "s1", "timestamp": 1000},
        {"type": "vfs", "session": "s1", "timestamp": 2000, "vfs": "read"},
    ]
    assert render_bash_history(events) == ""


def test_render_history_listing_numbers_and_width():
    events = [
        {
            "type": "command",
            "command": f"cmd {i}",
            "timestamp": i,
        }
        for i in range(12)
    ]
    lines = render_history_listing(events).splitlines()
    assert lines[0] == " 1  cmd 0"
    assert lines[-1] == "12  cmd 11"


def test_render_history_listing_last_n():
    events = [{"type": "command", "command": f"c{i}"} for i in range(5)]
    assert render_history_listing(events, n=2) == "4  c3\n5  c4\n"


def test_render_history_listing_zero_lists_nothing():
    events = [{"type": "command", "command": f"c{i}"} for i in range(5)]
    assert render_history_listing(events, n=0) == ""


def test_render_history_listing_caps_histsize():
    events = [{"type": "command", "command": f"c{i}"} for i in range(600)]
    lines = render_history_listing(events).splitlines()
    assert len(lines) == 500
    assert lines[0] == "  1  c100"
    assert lines[-1] == "500  c599"


def test_render_history_listing_empty():
    assert render_history_listing([]) == ""
