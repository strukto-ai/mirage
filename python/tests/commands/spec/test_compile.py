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

import pytest

from mirage.commands.spec.compile import compile_spec, expand_long
from mirage.commands.spec.types import (CommandSpec, Operand, OperandKind,
                                        Option)


def test_dest_prefers_long_and_keeps_short_only_identity():
    spec = CommandSpec(options=(
        Option(short="-a", long="--append"),
        Option(short="-e", value_kind=OperandKind.TEXT, multiple=True),
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
        short="-k", long="--key", value_kind=OperandKind.TEXT, multiple=True),
                                ))
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


def test_count_choices_required_default_tables():
    spec = CommandSpec(options=(
        Option(short="-v", long="--verbose", count=True),
        Option(long="--mode",
               value_kind=OperandKind.TEXT,
               choices=("a", "b"),
               default="a"),
        Option(long="--out", value_kind=OperandKind.TEXT, required=True),
    ))
    cs = compile_spec(spec)
    assert cs.count_dests == frozenset({"--verbose"})
    assert cs.choices_by_dest == {"--mode": ("a", "b")}
    assert cs.required_dests == ("--out", )
    assert cs.defaults == {"--mode": "a"}


def test_count_on_a_value_flag_is_a_spec_error():
    spec = CommandSpec(options=(
        Option(long="--level", value_kind=OperandKind.TEXT, count=True), ))
    try:
        compile_spec(spec)
    except ValueError as exc:
        assert "count requires a boolean flag" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_choices_on_a_boolean_flag_is_a_spec_error():
    spec = CommandSpec(options=(Option(long="--quiet", choices=("a", "b")), ))
    try:
        compile_spec(spec)
    except ValueError as exc:
        assert "require a value flag" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_default_outside_choices_is_a_spec_error():
    spec = CommandSpec(options=(Option(long="--mode",
                                       value_kind=OperandKind.TEXT,
                                       choices=("a", "b"),
                                       default="c"), ))
    try:
        compile_spec(spec)
    except ValueError as exc:
        assert "not one of its choices" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_type_int_requires_a_value_flag():
    with pytest.raises(ValueError, match="requires a value flag"):
        compile_spec(
            CommandSpec(options=(Option(long="--fast", type="int"), )))


def test_type_int_default_must_be_an_integer():
    with pytest.raises(ValueError, match="is not an integer"):
        compile_spec(
            CommandSpec(options=(Option(long="--port",
                                        value_kind=OperandKind.TEXT,
                                        type="int",
                                        default="auto"), )))


def test_expand_long_exact_prefix_ambiguous_and_unknown():
    cs = compile_spec(
        CommandSpec(options=(
            Option(long="--binary"),
            Option(long="--binary-files", value_kind=OperandKind.TEXT),
            Option(long="--count"))))
    assert expand_long(cs, "--binary") == ("--binary", )
    assert expand_long(cs, "--bin") == ("--binary", "--binary-files")
    assert expand_long(cs, "--co") == ("--count", )
    assert expand_long(cs, "--zz") == ()
    assert expand_long(cs, "--") == ()
