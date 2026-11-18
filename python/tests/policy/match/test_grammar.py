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

from mirage.commands.spec import SPECS
from mirage.commands.spec.parser import parse_command
from mirage.policy.match.grammar import leaf_read
from mirage.policy.types import FlagFact


def test_a_leaf_read_holds_each_option_by_its_canonical_name():
    for argv in (
        ["-rf", "x"],
        ["-r", "-f", "x"],
        ["--recursive", "--force", "x"],
    ):
        read = leaf_read(("rm",), parse_command(SPECS["rm"], argv, "/", "rm"))
        assert read.flags == (
            FlagFact("--recursive"),
            FlagFact("--force"),
        )
        assert read.operands == ("x",)


def test_a_leaf_read_keeps_an_options_value():
    read = leaf_read(
        ("head",), parse_command(SPECS["head"], ["-n", "2"], "/", "head")
    )
    assert read.flags == (FlagFact("--lines", ("2",)),)


def test_a_refused_line_keeps_what_the_grammar_read():
    def read(name: str, argv: list[str]):
        return leaf_read((name,), parse_command(SPECS[name], argv, "/", name))

    bogus = read("rm", ["--bogus", "-r", "x"])
    assert bogus.flags == (FlagFact("--recursive"), FlagFact("--bogus"))
    assert bogus.operands == ("x",)
    found = read("find", ["/d", "-type", "f", "-delete", "-exec", "echo", ";"])
    assert found.flags == (
        FlagFact("-type", ("f",)),
        FlagFact("-delete"),
        FlagFact("-e"),
    )
    assert found.operands == ("/d", "echo", ";")
    assert read("rm", ["--force=1", "x"]).flags == (FlagFact("--force"),)
    assert read("cp", ["-Q", "a", "b"]).flags == (FlagFact("-Q"),)
    assert read("grep", ["--c", "x"]).flags == (FlagFact("--c"),)
