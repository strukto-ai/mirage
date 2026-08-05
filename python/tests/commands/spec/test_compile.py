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
from mirage.commands.spec.types import CommandSpec, Operand, Option


def test_dest_prefers_long_and_keeps_short_only_identity():
    spec = CommandSpec(options=(
        Option(short="-a", long="--append"),
        Option(short="-e", type="str", multiple=True),
        Option(long="--color", type="str", value_optional=True),
    ))
    cs = compile_spec(spec)
    assert cs.dest_of("-a") == "--append"
    assert cs.dest_of("--append") == "--append"
    assert cs.dest_of("-e") == "-e"
    assert cs.dest_of("--color") == "--color"


def test_multiple_dests_are_canonical():
    spec = CommandSpec(options=(
        Option(short="-k", long="--key", type="str", multiple=True), ))
    cs = compile_spec(spec)
    assert cs.multiple_dests == frozenset({"--key"})


def test_value_spellings_ordered_longest_first():
    # -name must win an attached match over -n, deterministically, not by
    # set iteration order.
    spec = CommandSpec(options=(
        Option(short="-n", type="str"),
        Option(short="-name", type="str"),
    ))
    cs = compile_spec(spec)
    assert cs.value_spellings == ("-name", "-n")


def test_numeric_dest_is_canonical():
    spec = CommandSpec(options=(Option(
        short="-n", long="--lines", type="str", numeric_shorthand=True), ))
    cs = compile_spec(spec)
    assert cs.numeric_dest == "--lines"


def test_kind_tables_split_spelling_and_dest():
    spec = CommandSpec(
        options=(Option(short="-f", long="--file", type="path"), ),
        rest=Operand(type="str"),
    )
    cs = compile_spec(spec)
    assert cs.kind_of["-f"] == "path"
    assert cs.kind_of["--file"] == "path"
    assert cs.kind_by_dest == {"--file": "path"}
    assert cs.rest_kind == "str"


def test_compile_is_cached_per_spec():
    spec = CommandSpec(options=(Option(short="-x"), ))
    assert compile_spec(spec) is compile_spec(spec)


def test_count_choices_required_default_tables():
    spec = CommandSpec(options=(
        Option(short="-v", long="--verbose", count=True),
        Option(long="--mode", type="str", choices=("a", "b"), default="a"),
        Option(long="--out", type="str", required=True),
    ))
    cs = compile_spec(spec)
    assert cs.count_dests == frozenset({"--verbose"})
    assert cs.choices_by_dest == {"--mode": ("a", "b")}
    assert cs.required_dests == ("--out", )
    assert cs.defaults == {"--mode": "a"}


def test_count_on_a_value_flag_is_a_spec_error():
    spec = CommandSpec(
        options=(Option(long="--level", type="str", count=True), ))
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
    spec = CommandSpec(options=(
        Option(long="--mode", type="str", choices=("a", "b"), default="c"), ))
    try:
        compile_spec(spec)
    except ValueError as exc:
        assert "not one of its choices" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_type_float_default_must_be_a_number():
    with pytest.raises(ValueError, match="is not a number"):
        compile_spec(
            CommandSpec(options=(
                Option(long="--ratio", type="float", default="fast"), )))


def test_type_int_default_must_be_an_integer():
    with pytest.raises(ValueError, match="is not an integer"):
        compile_spec(
            CommandSpec(
                options=(Option(long="--port", type="int", default="auto"), )))


def test_expand_long_exact_prefix_ambiguous_and_unknown():
    cs = compile_spec(
        CommandSpec(options=(Option(long="--binary"),
                             Option(long="--binary-files", type="str"),
                             Option(long="--count"))))
    assert expand_long(cs, "--binary") == ("--binary", )
    assert expand_long(cs, "--bin") == ("--binary", "--binary-files")
    assert expand_long(cs, "--co") == ("--count", )
    assert expand_long(cs, "--zz") == ()
    assert expand_long(cs, "--") == ()


def test_pair_on_a_boolean_flag_is_a_spec_error():
    spec = CommandSpec(options=(Option(long="--arg", pair=True), ))
    with pytest.raises(ValueError, match="pair requires a value flag"):
        compile_spec(spec)


def test_pair_with_a_short_spelling_is_a_spec_error():
    spec = CommandSpec(
        options=(Option(short="-a", long="--arg", type="str", pair=True), ))
    with pytest.raises(ValueError, match="pair requires a long spelling"):
        compile_spec(spec)


def test_pair_of_paths_types_only_the_value():
    # jq --rawfile name file: the name is text, the file is a path.
    spec = CommandSpec(
        options=(Option(long="--rawfile", type="path", pair=True), ))
    compiled = compile_spec(spec)
    assert compiled.kind_by_dest["--rawfile"] == "path"
    assert "--rawfile" in compiled.pair_dests


def test_pair_accumulates_like_multiple():
    spec = CommandSpec(options=(Option(long="--arg", type="str", pair=True), ))
    compiled = compile_spec(spec)
    assert "--arg" in compiled.pair_dests
    assert "--arg" in compiled.multiple_dests
