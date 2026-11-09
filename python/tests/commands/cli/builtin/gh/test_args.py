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

from mirage.commands.cli.builtin.gh.args import (
    JQ,
    JSON,
    REPO,
    TEMPLATE,
    flag,
)
from mirage.commands.spec.parser import ParsedArgs, parse_command
from mirage.commands.spec.types import CommandSpec

SPEC = CommandSpec(
    name="list",
    arguments=(
        REPO,
        JSON,
        JQ,
        TEMPLATE,
        flag("-d", "--draft", "Filter by draft"),
        flag("-s", "--stale"),
        flag(long="--web"),
    ),
)


def _parse(*words: str) -> ParsedArgs:
    return parse_command(SPEC, list(words), "/", "gh")


def test_a_bare_flag_is_true():
    assert _parse("--draft").flags == {"--draft": True}


def test_an_attached_value_spells_the_flag_out():
    assert _parse("--draft=false").flags == {"--draft": "false"}
    assert _parse("--draft=true").flags == {"--draft": "true"}


def test_the_next_word_is_never_the_flags_value():
    parsed = _parse("--draft", "false")
    assert parsed.flags == {"--draft": True}
    assert [word for word, _ in parsed.args] == ["false"]


def test_shorts_still_cluster():
    assert _parse("-ds").flags == {"--draft": True, "--stale": True}


def test_a_flag_needs_no_short():
    assert flag(long="--web").names == ("--web",)
    assert _parse("--web").flags == {"--web": True}


def test_the_help_line_and_value_name_carry_through():
    built = flag("-d", "--draft", "Filter by draft", "bool")
    assert built.names == ("-d", "--draft")
    assert built.help == "Filter by draft"
    assert built.metavar == "bool"


def test_the_shared_options_take_a_value():
    parsed = _parse("-R", "o/r", "--json", "a,b", "-q", ".x", "-t", "{{.}}")
    assert parsed.flags == {
        "--repo": "o/r",
        "--json": "a,b",
        "--jq": ".x",
        "--template": "{{.}}",
    }
