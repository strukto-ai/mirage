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

from mirage.commands.spec.builtin_specs import SPECS
from mirage.commands.spec.builtins import (
    help_spec,
    is_builtin_grammar,
    registered_spec,
)
from mirage.commands.spec.constants import HELP_OPTION, VERSION_OPTION
from mirage.commands.spec.types import Argument, CommandSpec


def test_help_spec_appends_the_two_standard_options():
    spec = CommandSpec(arguments=(Argument("texts", nargs="*", metavar=""),))
    enriched = help_spec(spec)
    assert enriched.arguments == (*spec.arguments, HELP_OPTION, VERSION_OPTION)
    assert enriched.arguments[0] is spec.arguments[0]


def test_help_spec_leaves_a_declared_option_alone():
    own = Argument("--version", action="store_true", help="mine")
    spec = CommandSpec(arguments=(own,))
    enriched = help_spec(spec)
    assert enriched.arguments == (own, HELP_OPTION)


def test_help_spec_returns_the_same_spec_when_both_are_declared():
    spec = CommandSpec(
        arguments=(
            Argument("--help", action="store_true"),
            Argument("--version", action="store_true"),
        )
    )
    assert help_spec(spec) is spec


# One enriched object per builtin, not one per backend that registers
# the command, which is what makes is_builtin_grammar a pointer compare.
def test_registered_spec_shares_one_copy_per_builtin():
    first = registered_spec("tee", SPECS["tee"])
    assert first is registered_spec("tee", SPECS["tee"])
    assert first is not SPECS["tee"]


def test_registered_spec_builds_a_fresh_copy_for_a_custom_spec():
    spec = CommandSpec(arguments=(Argument("texts", nargs="*", metavar=""),))
    assert registered_spec("tee", spec) is not registered_spec("tee", spec)


def test_a_builtin_grammar_is_recognized_declared_or_registered():
    assert is_builtin_grammar("expr", SPECS["expr"])
    assert is_builtin_grammar("expr", registered_spec("expr", SPECS["expr"]))


# The whole point: a name is not an identity. A mount may register a
# command under a builtin's name and nothing refuses it, so the measured
# per-program rules must not follow the name.
def test_a_borrowed_name_is_not_the_builtin_grammar():
    spec = CommandSpec(
        arguments=(
            Argument("--mode"),
            Argument("texts", nargs="*", metavar=""),
        )
    )
    assert not is_builtin_grammar("expr", spec)
    assert not is_builtin_grammar("expr", registered_spec("expr", spec))
    # A spec that reproduces expr's field for field is still its own
    # object: CommandSpec is a frozen dataclass, so `==` would say yes.
    twin = CommandSpec(
        description=SPECS["expr"].description,
        arguments=(Argument("texts", nargs="*", metavar=""),),
    )
    assert twin == SPECS["expr"]
    assert not is_builtin_grammar("expr", twin)


def test_an_unknown_name_is_never_a_builtin_grammar():
    assert not is_builtin_grammar("nope", CommandSpec())
    assert not is_builtin_grammar("expr", None)
