from collections.abc import Awaitable, Callable

import pytest

import mirage.commands.builtin.generic.sort as sort_module
from mirage.commands.builtin.errors import SortKeyError
from mirage.commands.builtin.generic.sort import (
    parse_flags,
    sort_generic,
)
from mirage.commands.errors import UsageError
from mirage.io.types import IOResult, materialize
from mirage.shell.descriptors import unreadable_stdin
from mirage.types import PathSpec


async def _unused_read_bytes(_path: PathSpec) -> bytes:
    raise AssertionError("read_bytes should not be called")


# GNU's word-choice refusal names the refused word quoted, so a byte
# outside 0x20-0x7e comes back escaped. Rows measured against
# GNU coreutils 9.4 under `LC_ALL=C` with a raw `bytes` argv
# (`sort --check=<w>`). Mirrored in sort.test.ts.
@pytest.mark.parametrize(
    "value,escaped",
    [
        ("xé", r"x\303\251"),
        ("x\r", r"x\r"),
        ("qu1et", "qu1et"),
    ],
)
def test_check_refusal_quotes_the_word(value, escaped):
    with pytest.raises(UsageError) as exc:
        parse_flags({"check": value})
    assert str(exc.value).startswith(
        f"sort: invalid argument '{escaped}' for '--check'\n"
    )


# GNU resolves an unambiguous prefix of one candidate, so
# `sort --check=q`, `=s` and `=d` all exit 0 (measured, coreutils 9.4).
# `quiet` and `silent` are one value, so its canonical word decides
# whether the check is quiet.
def test_check_accepts_an_unambiguous_prefix():
    assert parse_flags({"check": "q"}).check_quiet
    assert not parse_flags({"check": "d"}).check_quiet
    assert parse_flags({"check": "d"}).check


def _spec(virtual: str, raw: str | None = None) -> PathSpec:
    return PathSpec(
        virtual=virtual,
        directory=virtual[: virtual.rfind("/") + 1],
        vfs_path=virtual,
        raw_path=raw,
    )


def _reader(
    files: dict[str, bytes | OSError],
) -> Callable[[PathSpec], Awaitable[bytes]]:
    async def read_bytes(path: PathSpec) -> bytes:
        value = files[path.virtual]
        if isinstance(value, OSError):
            raise value
        return value

    return read_bytes


async def _stderr(io: IOResult) -> bytes:
    return await materialize(io.stderr) if io.stderr is not None else b""


# Every row below was measured against GNU coreutils 9.7 on
# debian:stable-slim under LC_ALL=C.
@pytest.mark.asyncio
async def test_the_input_is_named_as_typed_and_quoted_when_it_needs_it():
    _, io = await sort_generic(
        [_spec("/data/no such.txt", "no such.txt")],
        read=_reader(
            {"/data/no such.txt": FileNotFoundError("/data/no such.txt")}
        ),
        flags={},
    )
    assert await _stderr(io) == (
        b"sort: cannot read: 'no such.txt': No such file or directory\n"
    )


@pytest.mark.asyncio
async def test_the_first_input_to_fail_its_access_check_ends_the_run():
    files: dict[str, bytes | OSError] = {
        "/data/m1": FileNotFoundError("/data/m1"),
    }
    _, io = await sort_generic(
        [_spec("/data/m1"), _spec("/data/m2")],
        read=_reader(files),
        flags={},
    )
    assert await _stderr(io) == (
        b"sort: cannot read: /data/m1: No such file or directory\n"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags,verb",
    [
        ({}, b"stat failed"),
        ({"merge": True}, b"read failed"),
    ],
)
async def test_a_closed_stdin_fails_where_gnu_first_touches_it(flags, verb):
    _, io = await sort_generic(
        [],
        read=_unused_read_bytes,
        stdin=unreadable_stdin(),
        flags=flags,
    )
    assert (
        await _stderr(io) == b"sort: " + verb + b": -: Bad file descriptor\n"
    )
    assert io.exit_code == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags,mode",
    [
        ({"c": True}, "c"),
        ({"check": "quiet"}, "C"),
    ],
)
async def test_check_refuses_an_output_by_its_own_letter(flags, mode):
    flags = {**flags, "output": [_spec("/data/out.txt")]}
    _, io = await sort_generic(
        [], read=_unused_read_bytes, stdin=b"b\na\n", flags=flags
    )
    assert await _stderr(io) == (
        f"sort: options '-{mode}o' are incompatible\n".encode()
    )
    assert io.exit_code == 2


@pytest.mark.asyncio
async def test_a_second_operand_outranks_the_output_and_names_the_mode():
    _, io = await sort_generic(
        [_spec("/data/a"), _spec("/data/b")],
        read=_unused_read_bytes,
        flags={"C": True, "output": [_spec("/data/out.txt")]},
    )
    assert await _stderr(io) == (
        b"sort: extra operand '/data/b' not allowed with -C\n"
    )
    assert io.exit_code == 2


@pytest.mark.parametrize(
    "flags",
    [
        {"c": True, "C": True},
        {"check": "silent", "c": True},
    ],
)
def test_the_two_check_modes_refuse_to_mix(flags):
    with pytest.raises(UsageError) as exc:
        parse_flags(flags)
    assert str(exc.value) == "sort: options '-cC' are incompatible"
    assert exc.value.exit_code == 2


def test_one_mode_may_be_asked_for_twice():
    assert parse_flags({"C": True, "check": "quiet"}).check_quiet
    assert parse_flags({"c": True, "check": "diagnose-first"}).check


def test_two_outputs_are_refused_unless_they_name_one_file():
    with pytest.raises(UsageError) as exc:
        parse_flags({"output": [_spec("/data/p1"), _spec("/data/p2")]})
    assert str(exc.value) == "sort: multiple output files specified"
    assert exc.value.exit_code == 2
    parsed = parse_flags({"output": [_spec("/data/p1"), _spec("/data/p1")]})
    assert parsed.output is not None and parsed.output.virtual == "/data/p1"


def test_the_first_bad_option_on_the_line_is_the_one_refused():
    outputs = [_spec("/data/p1"), _spec("/data/p2")]
    with pytest.raises(UsageError):
        parse_flags({"output": outputs, "key": ["0"]})
    with pytest.raises(SortKeyError):
        parse_flags({"key": ["0"], "output": outputs})
    with pytest.raises(UsageError) as exc:
        parse_flags({"c": True, "C": True, "output": outputs})
    assert "'-cC'" in str(exc.value)


_MIXED = {"numeric_sort": True, "general_numeric_sort": True}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags,refusal",
    [
        (
            {"key": ["0"]},
            b"sort: field number is zero: invalid field specification '0'\n",
        ),
        ({"c": True, "C": True}, b"sort: options '-cC' are incompatible\n"),
    ],
)
async def test_the_option_loop_outranks_incompatible_orderings(flags, refusal):
    _, io = await sort_generic(
        [],
        read=_unused_read_bytes,
        stdin=b"a\n",
        flags={**_MIXED, **flags},
    )
    assert await _stderr(io) == refusal
    assert io.exit_code == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "paths,flags",
    [
        (["/data/a", "/data/b"], {"c": True}),
        (["/data/missing"], {}),
    ],
)
async def test_incompatible_orderings_outrank_the_operands(paths, flags):
    _, io = await sort_generic(
        [_spec(path) for path in paths],
        read=_reader({"/data/missing": FileNotFoundError("/data/missing")}),
        flags={**_MIXED, **flags},
    )
    assert await _stderr(io) == b"sort: options '-gn' are incompatible\n"
    assert io.exit_code == 2


@pytest.mark.asyncio
async def test_merge_trusts_its_inputs_and_never_reorders_one():
    stdout, _ = await sort_generic(
        [_spec("/data/in.txt")],
        read=_reader({"/data/in.txt": b"b\na\n"}),
        flags={"merge": True},
    )
    assert await materialize(stdout) == b"b\na\n"
    stdout, _ = await sort_generic(
        [_spec("/data/s1"), _spec("/data/s2")],
        read=_reader({"/data/s1": b"c\na\n", "/data/s2": b"b\n"}),
        flags={"merge": True},
    )
    assert await materialize(stdout) == b"b\nc\na\n"


WORDS = ["b", "a", "B", "10", "9", "c x", "a y", "a x"]


async def _sorted(lines, flags):
    stdout, result = await sort_generic(
        [_spec("/data/in.txt")],
        read=_reader({"/data/in.txt": "\n".join(lines).encode()}),
        flags=flags,
    )
    assert result.exit_code == 0
    return await materialize(stdout)


@pytest.mark.parametrize(
    "flags",
    [
        {},
        {"reverse": True},
        {"unique": True},
        {"numeric_sort": True, "unique": True},
        {"key": ["2,2"], "stable": True},
        {"ignore_case": True, "unique": True, "reverse": True},
    ],
)
@pytest.mark.asyncio
async def test_a_sort_spilled_into_runs_orders_as_one_sort(flags, monkeypatch):
    lines = [
        f"{WORDS[i % len(WORDS)]} {WORDS[i * 7 % len(WORDS)]} {i % 5}"
        for i in range(643)
    ]
    want = await _sorted(lines, flags)
    monkeypatch.setattr(sort_module, "SORT_RUN_BYTES", 256)
    monkeypatch.setattr(sort_module, "MERGE_FAN_IN", 2)
    assert await _sorted(lines, flags) == want


@pytest.mark.asyncio
async def test_long_records_sort_as_one_sort(monkeypatch):
    lines = [
        f"{WORDS[i % len(WORDS)] * (i * 997 % 4000)} {i % 3}"
        for i in range(60)
    ]
    want = await _sorted(lines, {"key": ["2,2"]})
    monkeypatch.setattr(sort_module, "SORT_RUN_BYTES", 4096)
    monkeypatch.setattr(sort_module, "MERGE_FAN_IN", 2)
    assert await _sorted(lines, {"key": ["2,2"]}) == want


@pytest.mark.asyncio
async def test_each_input_ends_its_last_record():
    stdout, _ = await sort_generic(
        [_spec("/data/a"), _spec("/data/b")],
        read=_reader({"/data/a": b"c", "/data/b": b"b\na"}),
        flags={},
    )
    assert await materialize(stdout) == b"a\nb\nc\n"
    stdout, _ = await sort_generic(
        [_spec("/data/a")],
        read=_reader({"/data/a": b"b\na"}),
        flags={"merge": True},
    )
    assert await materialize(stdout) == b"b\na\n"


@pytest.mark.asyncio
async def test_bytes_that_are_not_utf8_come_back_unchanged():
    stdout, _ = await sort_generic(
        [_spec("/data/a")],
        read=_reader({"/data/a": b"\xff\nb\n\xc3\xa9\n"}),
        flags={},
    )
    assert await materialize(stdout) == b"b\n\xc3\xa9\n\xff\n"


@pytest.mark.asyncio
async def test_check_names_the_disordered_record():
    _, result = await sort_generic(
        [_spec("/data/a")],
        read=_reader({"/data/a": b"a\nc\nb\n"}),
        flags={"c": True},
    )
    assert result.exit_code == 1
    assert await _stderr(result) == b"sort: /data/a:3: disorder: b\n"


@pytest.mark.asyncio
async def test_external_sort_preserves_stability_across_spill_and_merge_levels(
    monkeypatch,
):
    monkeypatch.setattr(sort_module, "SORT_RUN_BYTES", 128)
    monkeypatch.setattr(sort_module, "MERGE_FAN_IN", 2)
    lines = [f"{i % 7} item{i}" for i in range(97)]
    flags = {"key": ["1,1"], "stable": True}
    stdout, result = await sort_generic(
        [],
        read=_unused_read_bytes,
        stdin=("\n".join(lines) + "\n").encode(),
        flags=flags,
    )
    assert (await materialize(stdout)).decode().splitlines() == sorted(
        lines, key=lambda line: line.split()[0]
    )
    assert result.exit_code == 0
