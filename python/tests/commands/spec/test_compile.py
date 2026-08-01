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

from mirage.commands.spec.compile import compile_spec
from mirage.commands.spec.types import (CommandSpec, Operand, OperandKind,
                                        Option)


def test_dest_prefers_long_and_keeps_short_only_identity():
    spec = CommandSpec(options=(
        Option(short="-a", long="--append"),
        Option(short="-e", value_kind=OperandKind.TEXT, repeatable=True),
        Option(
            long="--color", value_kind=OperandKind.TEXT, value_optional=True),
    ))
    cs = compile_spec(spec)
    assert cs.dest_of("-a") == "--append"
    assert cs.dest_of("--append") == "--append"
    assert cs.dest_of("-e") == "-e"
    assert cs.dest_of("--color") == "--color"


def test_multiple_dests_are_canonical():
    spec = CommandSpec(options=(Option(
        short="-k", long="--key", value_kind=OperandKind.TEXT,
        repeatable=True), ))
    cs = compile_spec(spec)
    assert cs.multiple_dests == frozenset({"--key"})


def test_value_spellings_ordered_longest_first():
    # -name must win an attached match over -n, deterministically, not by
    # set iteration order.
    spec = CommandSpec(options=(
        Option(short="-n", value_kind=OperandKind.TEXT),
        Option(short="-name", value_kind=OperandKind.TEXT),
    ))
    cs = compile_spec(spec)
    assert cs.value_spellings == ("-name", "-n")


def test_numeric_dest_is_canonical():
    spec = CommandSpec(options=(Option(short="-n",
                                       long="--lines",
                                       value_kind=OperandKind.TEXT,
                                       numeric_shorthand=True), ))
    cs = compile_spec(spec)
    assert cs.numeric_dest == "--lines"


def test_kind_tables_split_spelling_and_dest():
    spec = CommandSpec(
        options=(Option(short="-f", long="--file",
                        value_kind=OperandKind.PATH), ),
        rest=Operand(kind=OperandKind.TEXT),
    )
    cs = compile_spec(spec)
    assert cs.kind_of["-f"] == OperandKind.PATH
    assert cs.kind_of["--file"] == OperandKind.PATH
    assert cs.kind_by_dest == {"--file": OperandKind.PATH}
    assert cs.rest_kind == OperandKind.TEXT


def test_compile_is_cached_per_spec():
    spec = CommandSpec(options=(Option(short="-x"), ))
    assert compile_spec(spec) is compile_spec(spec)
