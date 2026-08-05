import pytest

from mirage.commands.builtin.generic.jq import (assemble_inputs, exit_code, jq,
                                                named_args, parse_flags,
                                                positional_args)
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.jq import JqOptions
from mirage.io.types import materialize
from mirage.types import PathSpec

FILES = {
    "/d/user.json": b'{"name":"alice","age":30}\n',
    "/d/multi.json": b'{"a":1}\n{"a":2}\n{"a":3}\n',
    "/d/lines.txt": b"alpha\nbeta\ngamma\n",
    "/d/empty.txt": b"",
    "/d/prog.jq": b".name\n",
    "/d/lines2.txt": b"alpha\nbeta\ngamma\n",
    "/d/a.json": b'{"a":1}\n',
    "/d/b.json": b'{"b":2}\n',
    "/d/fields.json": b'{"inputs":1}\n{"inputs":2}\n',
}


async def _read_bytes(path: PathSpec) -> bytes:
    return FILES[path.virtual]


def _unused_read_stream(_path):
    raise AssertionError("the streaming path must not serve a .json operand")


def _path(virtual: str) -> PathSpec:
    return PathSpec(virtual, virtual.rsplit("/", 1)[0], virtual.lstrip("/"))


def _spec_flags(**flags: object) -> FlagView:
    return FlagView(flags, spec=SPECS["jq"])


async def _run(paths: list[str], *texts: str, **flags: object) -> tuple:
    source, io = await jq([_path(p) for p in paths],
                          *texts,
                          read_bytes=_read_bytes,
                          read_stream=_unused_read_stream,
                          **flags)
    return await materialize(source) if source is not None else b"", io


def test_join_and_nul_output_imply_raw():
    assert parse_flags(_spec_flags(join_output=True)).raw_output
    assert parse_flags(_spec_flags(raw_output0=True)).raw_output


def test_indent_minus_one_is_tab_indentation():
    opts = parse_flags(_spec_flags(indent="-1"))
    assert opts.tab
    assert opts.indent == 2


def test_indent_out_of_range_is_a_usage_error():
    with pytest.raises(UsageError, match="between -1 and 7"):
        parse_flags(_spec_flags(indent="8"))


def test_named_args_pair_up_the_flattened_tokens():
    args = named_args(_spec_flags(arg=["a", "1", "b", "2"]))
    assert args == {"a": "1", "b": "2"}


def test_argjson_parses_its_value_as_json():
    args = named_args(_spec_flags(argjson=["v", '{"k":[1,2]}']))
    assert args == {"v": {"k": [1, 2]}}


def test_argjson_rejects_invalid_json():
    with pytest.raises(UsageError, match="invalid JSON text"):
        named_args(_spec_flags(argjson=["v", "nope"]))


def test_slurp_spans_every_input_rather_than_each_one():
    chunks = [b'{"a":1}', b'{"b":2}']
    assert assemble_inputs(chunks, JqOptions(slurp=True)) == [[{
        "a": 1
    }, {
        "b": 2
    }]]


def test_raw_input_splits_lines_per_input():
    chunks = [b"x\ny", b"z\n"]
    opts = JqOptions(raw_input=True)
    assert assemble_inputs(chunks, opts) == ["x", "y", "z"]


def test_raw_slurp_joins_every_input_into_one_string():
    chunks = [b"x\n", b"y\n"]
    opts = JqOptions(raw_input=True, slurp=True)
    assert assemble_inputs(chunks, opts) == ["x\ny\n"]


def test_exit_status_reads_the_last_output_only():
    opts = JqOptions(exit_status=True)
    assert exit_code([1, False], opts) == 1
    assert exit_code([False, 1], opts) == 0
    assert exit_code([None], opts) == 1
    assert exit_code([], opts) == 4


def test_exit_status_is_zero_without_the_flag():
    assert exit_code([], JqOptions()) == 0
    assert exit_code([None], JqOptions()) == 0


@pytest.mark.asyncio
async def test_raw_input_reads_each_line_as_a_string():
    out, io = await _run(["/d/lines.txt"], ".", raw_input=True)
    assert out == b'"alpha"\n"beta"\n"gamma"\n'
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_raw_slurp_is_one_string_including_the_last_newline():
    out, _ = await _run(["/d/lines.txt"], ".", raw_input=True, slurp=True)
    assert out == b'"alpha\\nbeta\\ngamma\\n"\n'


@pytest.mark.asyncio
async def test_null_input_with_inputs_collects_the_whole_stream():
    out, _ = await _run(["/d/lines.txt"],
                        "[inputs]",
                        raw_input=True,
                        null_input=True,
                        compact_output=True)
    assert out == b'["alpha","beta","gamma"]\n'


@pytest.mark.asyncio
async def test_null_input_never_reads_its_operands():
    out, io = await _run(["/d/missing.json"], "1+2", null_input=True)
    assert out == b"3\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_inputs_without_null_input_drains_the_stream_once():
    out, _ = await _run(["/d/multi.json"], "[., inputs]", compact_output=True)
    assert out == b'[{"a":1},{"a":2},{"a":3}]\n'


@pytest.mark.asyncio
async def test_a_field_named_inputs_still_runs_per_document():
    out, _ = await _run(["/d/fields.json"], ".inputs", compact_output=True)
    assert out == b"1\n2\n"


@pytest.mark.asyncio
async def test_the_word_inputs_in_a_string_still_runs_per_document():
    out, _ = await _run(["/d/multi.json"], '"no inputs"', compact_output=True)
    assert out == b'"no inputs"\n"no inputs"\n"no inputs"\n'


@pytest.mark.asyncio
async def test_slurp_covers_operands_together():
    out, _ = await _run(["/d/a.json", "/d/b.json"],
                        ".",
                        slurp=True,
                        compact_output=True)
    assert out == b'[{"a":1},{"b":2}]\n'


@pytest.mark.asyncio
async def test_empty_input_prints_nothing_and_exits_zero():
    out, io = await _run(["/d/empty.txt"], ".")
    assert out == b""
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_named_args_reach_the_program():
    out, _ = await _run(["/d/user.json"],
                        "[.name, $v]",
                        arg=["v", "hi"],
                        compact_output=True)
    assert out == b'["alice","hi"]\n'


@pytest.mark.asyncio
async def test_from_file_reads_the_program_off_a_path():
    path = _path("/d/prog.jq")
    out, _ = await _run(["/d/user.json"], from_file=path)
    assert out == b'"alice"\n'


@pytest.mark.asyncio
async def test_exit_status_flag_reports_a_null_output():
    out, io = await _run(["/d/user.json"], ".missing", exit_status=True)
    assert out == b"null\n"
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_exit_status_flag_reports_no_output_at_all():
    out, io = await _run(["/d/user.json"], "empty", exit_status=True)
    assert out == b""
    assert io.exit_code == 4


def test_positional_args_are_text_by_default():
    fl = _spec_flags(args=True)
    assert positional_args(fl, [".", "a", "b"], False) == ("a", "b")


def test_positional_args_keep_every_operand_when_f_gave_the_program():
    fl = _spec_flags(args=True)
    assert positional_args(fl, ["a", "b"], True) == ("a", "b")


def test_jsonargs_parses_each_operand():
    fl = _spec_flags(jsonargs=True)
    assert positional_args(fl, [".", "1", '{"k":2}'], False) == (1, {"k": 2})


def test_jsonargs_rejects_invalid_json():
    with pytest.raises(UsageError, match="invalid JSON text"):
        positional_args(_spec_flags(jsonargs=True), [".", "nope"], False)


def test_no_positional_args_without_the_flags():
    assert positional_args(_spec_flags(), [".", "a"], False) == ()


def test_stream_expands_documents_into_events():
    chunks = [b'{"a":1}']
    assert assemble_inputs(chunks, JqOptions(stream=True)) == [[["a"], 1],
                                                               [["a"]]]


def test_stream_and_slurp_collect_the_events():
    chunks = [b'{"a":1}']
    opts = JqOptions(stream=True, slurp=True)
    assert assemble_inputs(chunks, opts) == [[[["a"], 1], [["a"]]]]


def test_seq_reads_only_rs_introduced_values():
    chunks = [b'\x1e{"a":1}\n\x1e{"a":2}\n']
    assert assemble_inputs(chunks, JqOptions(seq=True)) == [{"a": 1}, {"a": 2}]


def test_seq_drops_text_before_the_first_separator():
    assert assemble_inputs([b'{"a":1}\n'], JqOptions(seq=True)) == []


@pytest.mark.asyncio
async def test_rawfile_binds_the_files_text():
    out, _ = await _run([],
                        "$x",
                        null_input=True,
                        compact_output=True,
                        rawfile=["x", _path("/d/lines.txt")])
    assert out == b'"alpha\\nbeta\\ngamma\\n"\n'


@pytest.mark.asyncio
async def test_slurpfile_binds_the_files_documents():
    out, _ = await _run([],
                        "$x",
                        null_input=True,
                        compact_output=True,
                        slurpfile=["x", _path("/d/multi.json")])
    assert out == b'[{"a":1},{"a":2},{"a":3}]\n'


@pytest.mark.asyncio
async def test_args_reach_the_program_through_dollar_args():
    out, _ = await _run([],
                        "$ARGS",
                        "a",
                        "b",
                        null_input=True,
                        compact_output=True,
                        args=True)
    assert out == b'{"positional":["a","b"],"named":{}}\n'


@pytest.mark.asyncio
async def test_dollar_args_carries_the_named_bindings():
    out, _ = await _run([],
                        "$ARGS.named",
                        null_input=True,
                        compact_output=True,
                        arg=["v", "hi"])
    assert out == b'{"v":"hi"}\n'


@pytest.mark.asyncio
async def test_dollar_args_is_defined_with_no_bindings_at_all():
    out, _ = await _run([], "$ARGS", null_input=True, compact_output=True)
    assert out == b'{"positional":[],"named":{}}\n'


@pytest.mark.asyncio
async def test_stream_reads_a_document_as_events():
    out, _ = await _run(["/d/a.json"], ".", stream=True, compact_output=True)
    assert out == b'[["a"],1]\n[["a"]]\n'


@pytest.mark.asyncio
async def test_seq_writes_a_separator_before_each_value():
    out, _ = await _run([],
                        "1,2",
                        null_input=True,
                        seq=True,
                        compact_output=True)
    assert out == b"\x1e1\n\x1e2\n"
