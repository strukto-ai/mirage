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

from mirage.runtime.policy import parsed_commands
from mirage.shell.parse import parse


def test_parsed_commands_parse_pipes_and_lists():
    commands = parsed_commands(
        parse("cat /a/big.csv | python3 /r/x.py 1 && nope"))
    assert [c.command for c in commands] == ["cat", "python3", "nope"]
    assert commands[0].paths == ("/a/big.csv", )
    assert commands[1].words == ("python3", "/r/x.py", "1")
    assert commands[0].builtin and commands[1].builtin
    assert not commands[2].builtin
    assert all(c.cli is None for c in commands)


def test_parsed_commands_tag_installed_cli_heads():
    commands = parsed_commands(parse("slack send hi | cat /x/slack"),
                               clis={"slack"})
    assert commands[0].cli == "slack"
    # Only the head word tags: `slack` as an operand stays untagged.
    assert commands[1].cli is None


def test_parsed_commands_empty_on_unparsable():
    assert parsed_commands(parse("")) == ()
