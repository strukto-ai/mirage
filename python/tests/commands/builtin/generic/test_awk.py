import pytest

from mirage.commands.builtin.generic.awk import awk
from mirage.commands.errors import UsageError
from mirage.types import PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(resource_path=(path).strip("/"),
                    virtual=path,
                    directory=path,
                    resolved=True)


def _make_backend(files: dict[str, bytes]):

    async def read_bytes(path):
        key = path.virtual if isinstance(path, PathSpec) else path
        if key not in files:
            raise FileNotFoundError(key)
        return files[key]

    async def read_stream(path):
        assert isinstance(path, PathSpec)
        key = path.virtual
        if key not in files:
            raise FileNotFoundError(key)
        yield files[key]

    return read_bytes, read_stream


async def _drain(stdout) -> bytes:
    if stdout is None:
        return b""
    if isinstance(stdout, bytes):
        return stdout
    return b"".join([c async for c in stdout])


@pytest.mark.asyncio
async def test_awk_stdin_print_field():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print $1}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"alpha beta\ngamma delta\n",
    )
    assert (await _drain(output)).decode() == "alpha\ngamma\n"


@pytest.mark.asyncio
async def test_awk_field_separator():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print $2}", ),
        {"F": ","},
        read_bytes=rb,
        read_stream=rs,
        stdin=b"a,b,c\nd,e,f\n",
    )
    assert (await _drain(output)).decode() == "b\ne\n"


@pytest.mark.asyncio
async def test_awk_variable_assignment():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print x}", ),
        {"v": ["x=hello"]},
        read_bytes=rb,
        read_stream=rs,
        stdin=b"line\n",
    )
    assert (await _drain(output)).decode() == "hello\n"


@pytest.mark.asyncio
async def test_awk_numeric_comparison():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("$1 > 2 {print $1}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"1\n2\n3\n4\n",
    )
    assert (await _drain(output)).decode() == "3\n4\n"


@pytest.mark.asyncio
async def test_awk_regex_condition():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("/foo/ {print $0}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"foo bar\nbaz\nfoobar\n",
    )
    assert (await _drain(output)).decode() == "foo bar\nfoobar\n"


@pytest.mark.asyncio
async def test_awk_end_block_accumulator():
    """sum += $1 with END {print sum} should emit total."""
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{sum += $1} END {print sum}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"10\n20\n30\n",
    )
    assert (await _drain(output)).decode() == "60\n"


@pytest.mark.asyncio
async def test_awk_reads_from_file():
    rb, rs = _make_backend({"/data.txt": b"hello world\n"})
    output, io = await awk(
        [_spec("/data.txt")],
        ("{print $2}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
    )
    assert (await _drain(output)).decode() == "world\n"
    assert io.cache == ["/data.txt"]


@pytest.mark.asyncio
async def test_awk_program_file_overrides_inline():
    rb, rs = _make_backend({
        "/prog.awk": b"{print $1}\n",
        "/data.txt": b"alpha beta\n",
    })
    output, _ = await awk(
        [_spec("/data.txt")],
        (),
        {"f": _spec("/prog.awk")},
        read_bytes=rb,
        read_stream=rs,
    )
    assert (await _drain(output)).decode() == "alpha\n"


@pytest.mark.asyncio
async def test_awk_missing_program_raises_usage_error():
    rb, rs = _make_backend({})
    with pytest.raises(UsageError, match="usage"):
        await awk([], (), None, read_bytes=rb, read_stream=rs)


@pytest.mark.asyncio
async def test_awk_default_fs_collapses_whitespace():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print $2}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"a   b\n\tx\t \ty\n",
    )
    assert (await _drain(output)).decode() == "b\ny\n"


@pytest.mark.asyncio
async def test_awk_explicit_single_space_fs_collapses_whitespace():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print $2}", ),
        {"F": " "},
        read_bytes=rb,
        read_stream=rs,
        stdin=b"a   b\n",
    )
    assert (await _drain(output)).decode() == "b\n"


@pytest.mark.asyncio
async def test_awk_empty_fs_splits_characters():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print $2}", ),
        {"F": ""},
        read_bytes=rb,
        read_stream=rs,
        stdin=b"abc\n",
    )
    assert (await _drain(output)).decode() == "b\n"


@pytest.mark.asyncio
async def test_awk_processes_all_files_with_continuous_nr():
    rb, rs = _make_backend({
        "/a.txt": b"one\ntwo\n",
        "/b.txt": b"three\n",
    })
    output, io = await awk(
        [_spec("/a.txt"), _spec("/b.txt")],
        ("{print NR, $1}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
    )
    assert (await _drain(output)).decode() == "1 one\n2 two\n3 three\n"
    assert io.cache == ["/a.txt", "/b.txt"]


@pytest.mark.asyncio
async def test_awk_multifile_no_trailing_newline_keeps_lines_separate():
    rb, rs = _make_backend({
        "/a.txt": b"one",
        "/b.txt": b"two\n",
    })
    output, _ = await awk(
        [_spec("/a.txt"), _spec("/b.txt")],
        ("{print NR, $1}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
    )
    assert (await _drain(output)).decode() == "1 one\n2 two\n"


@pytest.mark.asyncio
async def test_awk_repeated_v_assignments():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print a, b}", ),
        {"v": ["a=1", "b=2"]},
        read_bytes=rb,
        read_stream=rs,
        stdin=b"line\n",
    )
    assert (await _drain(output)).decode() == "1 2\n"


@pytest.mark.asyncio
async def test_awk_v_value_containing_equals():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print x}", ),
        {"v": ["x=a=b"]},
        read_bytes=rb,
        read_stream=rs,
        stdin=b"line\n",
    )
    assert (await _drain(output)).decode() == "a=b\n"


@pytest.mark.asyncio
async def test_awk_print_empty_string_emits_blank_line():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ('{print ""}', ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"one\ntwo\n",
    )
    assert (await _drain(output)).decode() == "\n\n"


@pytest.mark.asyncio
async def test_awk_action_without_print_emits_nothing():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{x += 1}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"one\ntwo\n",
    )
    assert (await _drain(output)).decode() == ""


@pytest.mark.asyncio
async def test_awk_brace_literal_in_print():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ('{print "}"}', ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"line\n",
    )
    assert (await _drain(output)).decode() == "}\n"


@pytest.mark.asyncio
async def test_awk_accumulator_non_numeric_coerces():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{sum += $1} END {print sum}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"3\nabc\n2.5x\n",
    )
    assert (await _drain(output)).decode() == "5.5\n"


@pytest.mark.asyncio
async def test_awk_program_file_missing_raises_usage_error():
    rb, rs = _make_backend({"/data.txt": b"x\n"})
    with pytest.raises(UsageError, match="No such file"):
        await awk(
            [_spec("/data.txt")],
            (),
            {"f": _spec("/missing.awk")},
            read_bytes=rb,
            read_stream=rs,
        )


@pytest.mark.asyncio
async def test_awk_program_file_with_multiple_data_files():
    rb, rs = _make_backend({
        "/prog.awk": b"{print NR, $1}\n",
        "/a.txt": b"one\n",
        "/b.txt": b"two\n",
    })
    output, io = await awk(
        [_spec("/a.txt"), _spec("/b.txt")],
        (),
        {"f": _spec("/prog.awk")},
        read_bytes=rb,
        read_stream=rs,
    )
    assert (await _drain(output)).decode() == "1 one\n2 two\n"
    assert io.cache == ["/a.txt", "/b.txt"]


@pytest.mark.asyncio
async def test_awk_begin_end_resolve_v_variables():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("BEGIN {print x} END {print x}", ),
        {"v": ["x=hi"]},
        read_bytes=rb,
        read_stream=rs,
        stdin=b"line\n",
    )
    assert (await _drain(output)).decode() == "hi\nhi\n"


@pytest.mark.asyncio
async def test_awk_duplicate_v_last_wins():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print x}", ),
        {"v": ["x=first", "x=second"]},
        read_bytes=rb,
        read_stream=rs,
        stdin=b"line\n",
    )
    assert (await _drain(output)).decode() == "second\n"


@pytest.mark.asyncio
async def test_awk_begin_bare_print_emits_blank_line():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ('BEGIN {print} {print $1}', ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"a\n",
    )
    assert (await _drain(output)).decode() == "\na\n"


@pytest.mark.asyncio
async def test_awk_brace_literal_with_condition():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ('/x/ {print "}"}', ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"x\ny\n",
    )
    assert (await _drain(output)).decode() == "}\n"


@pytest.mark.asyncio
async def test_awk_repeated_program_files_concatenate():
    rb, rs = _make_backend({
        "/p1.awk": b"{sum += $1}\n",
        "/p2.awk": b"END {print sum}\n",
        "/nums.txt": b"1\n2\n3\n",
    })
    output, _ = await awk(
        [_spec("/nums.txt")],
        (),
        {"f": [_spec("/p1.awk"), _spec("/p2.awk")]},
        read_bytes=rb,
        read_stream=rs,
    )
    assert (await _drain(output)).decode() == "6\n"


@pytest.mark.asyncio
async def test_awk_simple_assignment_executes():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{x = 1; print x}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"line\n",
    )
    assert (await _drain(output)).decode() == "1\n"


@pytest.mark.asyncio
async def test_awk_assignment_from_field():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{x = $2; print x}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"a b\n",
    )
    assert (await _drain(output)).decode() == "b\n"


@pytest.mark.asyncio
async def test_awk_ofs_joins_print_arguments():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ('BEGIN{OFS=":"} {print $1, $2}', ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"name age\nalice 30\n",
    )
    assert (await _drain(output)).decode() == "name:age\nalice:30\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "program, expected",
    [
        ("{{print $1}}", "Welcome\nInstall\n"),
        ("{{{print $1}}}", "Welcome\nInstall\n"),
        ("{{print $1}; print $2}", "Welcome\nto\nInstall\nit\n"),
        ("{print $1;{print $2}}", "Welcome\nto\nInstall\nit\n"),
    ],
)
async def test_awk_compound_statement_runs_its_body(program, expected):
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        (program, ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"Welcome to x\nInstall it\n",
    )
    assert (await _drain(output)).decode() == expected


@pytest.mark.asyncio
async def test_awk_semicolon_inside_string_is_not_a_separator():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ('{print "a;b", $1}', ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"x\n",
    )
    assert (await _drain(output)).decode() == "a;b x\n"


@pytest.mark.asyncio
async def test_awk_rejects_arithmetic_assignment():
    rb, rs = _make_backend({})
    with pytest.raises(UsageError, match="unsupported construct"):
        await awk(
            [],
            ("{x = y + 1; print x}", ),
            None,
            read_bytes=rb,
            read_stream=rs,
            stdin=b"line\n",
        )


@pytest.mark.asyncio
async def test_awk_rejects_function_call_in_print():
    rb, rs = _make_backend({})
    with pytest.raises(UsageError, match=r"unsupported construct.*toupper"):
        await awk(
            [],
            ("{print toupper($1)}", ),
            None,
            read_bytes=rb,
            read_stream=rs,
            stdin=b"line\n",
        )


@pytest.mark.asyncio
async def test_awk_rejects_printf():
    rb, rs = _make_backend({})
    with pytest.raises(UsageError, match="unsupported construct"):
        await awk(
            [],
            ('{printf "%s\\n", $1}', ),
            None,
            read_bytes=rb,
            read_stream=rs,
            stdin=b"line\n",
        )


@pytest.mark.asyncio
async def test_awk_rejects_if_statement():
    rb, rs = _make_backend({})
    with pytest.raises(UsageError, match="unsupported construct"):
        await awk(
            [],
            ("{if ($1) print $1}", ),
            None,
            read_bytes=rb,
            read_stream=rs,
            stdin=b"line\n",
        )


async def _run_stdin(program: str, stdin: bytes, flags=None) -> str:
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        (program, ),
        flags,
        read_bytes=rb,
        read_stream=rs,
        stdin=stdin,
    )
    return (await _drain(output)).decode()


FIELDS = b"alice 30 engineer\nbob 25 designer\ncarol 40 manager\n"


@pytest.mark.asyncio
async def test_awk_tilde_matches_a_field_against_a_regex():
    # Issue #1065: the standard field-regex predicate.
    out = await _run_stdin("$4 ~ /[Aa]pplication/ {print}",
                           b"a|b|c|Application\nx|y|z|Other\n", {"F": "|"})
    assert out == "a|b|c|Application\n"


@pytest.mark.asyncio
async def test_awk_boolean_operator_inside_a_regex_is_regex_text():
    # awk 20200816 and mawk 1.3.4 both print the line: the `&&` belongs
    # to the regex, it is not a conjunction.
    out = await _run_stdin("$0 ~ /A&&B/ {print}", b"xA&&By\nAB\n")
    assert out == "xA&&By\n"


@pytest.mark.asyncio
async def test_awk_boolean_operator_inside_a_string_is_string_text():
    out = await _run_stdin('$1 == "a||b" {print $2}', b"a||b q\nz 1\n")
    assert out == "q\n"


@pytest.mark.asyncio
async def test_awk_bare_regex_pattern_holding_an_operator_matches():
    out = await _run_stdin("/A&&B/", b"xA&&By\nAB\n")
    assert out == "xA&&By\n"


@pytest.mark.asyncio
async def test_awk_not_tilde_negates_the_match():
    out = await _run_stdin("$3 !~ /^d/ {print $1}", FIELDS)
    assert out == "alice\ncarol\n"


@pytest.mark.asyncio
async def test_awk_tilde_string_rhs_is_a_dynamic_regex():
    out = await _run_stdin('$2 ~ "0" && $1 ~ /^c/', FIELDS)
    assert out == "carol 40 manager\n"


@pytest.mark.asyncio
async def test_awk_tilde_variable_rhs_is_a_dynamic_regex():
    out = await _run_stdin("$1 ~ pat {print $2}", FIELDS, {"v": "pat=ar"})
    assert out == "40\n"


@pytest.mark.asyncio
async def test_awk_tilde_numeric_rhs_matches_as_text():
    out = await _run_stdin("$1 ~ 1", b"12\n3\n")
    assert out == "12\n"


@pytest.mark.asyncio
async def test_awk_tilde_lhs_may_be_nf_field_or_builtin():
    assert await _run_stdin("$NF ~ /^App/", b"x y Application\nx y Other\n") \
        == "x y Application\n"
    assert await _run_stdin("NR ~ /[13]/", b"a\nb\nc\n") == "a\nc\n"


@pytest.mark.asyncio
async def test_awk_tilde_regex_may_contain_a_comparison_operator():
    assert await _run_stdin("$0 ~ /a<b/", b"a<b\nab\n") == "a<b\n"
    assert await _run_stdin("$0 ~ /a==b/", b"a==b\nab\n") == "a==b\n"


@pytest.mark.asyncio
async def test_awk_bare_regex_may_contain_a_comparison_operator():
    assert await _run_stdin("/a<b/", b"a<b\nab\n") == "a<b\n"


@pytest.mark.asyncio
async def test_awk_tilde_regex_with_escaped_slash():
    assert await _run_stdin(r"$1 ~ /a\/b/", b"a/b\nab\n") == "a/b\n"


@pytest.mark.asyncio
async def test_awk_regex_brace_is_not_the_action_brace():
    assert await _run_stdin("$1 ~ /a{2}/ {print $2}", b"aa 1\na 2\n") == "1\n"


@pytest.mark.asyncio
async def test_awk_tilde_without_surrounding_spaces():
    assert await _run_stdin("$1~/a/", b"a b\nc d\n") == "a b\n"


@pytest.mark.asyncio
async def test_awk_negated_bare_regex():
    assert await _run_stdin("!/bob/ {print $1}", FIELDS) == "alice\ncarol\n"


@pytest.mark.asyncio
async def test_awk_negated_operand_tests_falsiness():
    assert await _run_stdin("!$1", b"0\n1\nfoo\n\n") == "0\n\n"
    assert await _run_stdin("!x", b"a\nb\n", {"v": "x=0"}) == "a\nb\n"


@pytest.mark.asyncio
async def test_awk_tilde_invalid_regex_is_usage_error():
    # Exit 2, like mawk and onetrueawk (gawk exits 1 here).
    with pytest.raises(UsageError,
                       match=r"awk: syntax error in regular expression "
                       r"\(a at source line 1"):
        await _run_stdin("$1 ~ /(a/ {print}", b"a\n")


@pytest.mark.asyncio
async def test_awk_bare_invalid_regex_is_usage_error():
    with pytest.raises(UsageError, match="syntax error in regular expression"):
        await _run_stdin("/(a/", b"a\n")


@pytest.mark.asyncio
async def test_awk_tilde_rejects_an_unsupported_lhs():
    with pytest.raises(UsageError, match="unsupported construct"):
        await _run_stdin("length($1) ~ /1/", b"a\n")


@pytest.mark.asyncio
async def test_awk_rejects_arithmetic_in_condition():
    rb, rs = _make_backend({})
    with pytest.raises(UsageError, match="unsupported construct"):
        await awk(
            [],
            ("NR % 2 == 0 {print}", ),
            None,
            read_bytes=rb,
            read_stream=rs,
            stdin=b"a\nb\n",
        )


@pytest.mark.asyncio
async def test_awk_rejects_program_file_with_unsupported_statement():
    rb, rs = _make_backend({"/p.awk": b'{gsub(/a/, "b"); print}\n'})
    with pytest.raises(UsageError, match="unsupported construct"):
        await awk(
            [],
            (),
            {"f": [_spec("/p.awk")]},
            read_bytes=rb,
            read_stream=rs,
            stdin=b"line\n",
        )


@pytest.mark.asyncio
async def test_awk_unset_variable_prints_empty():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print foo}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"line\n",
    )
    assert (await _drain(output)).decode() == "\n"


@pytest.mark.asyncio
async def test_awk_out_of_range_field_prints_empty():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print $5}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"one two\n",
    )
    assert (await _drain(output)).decode() == "\n"
