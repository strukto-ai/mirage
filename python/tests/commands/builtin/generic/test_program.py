import pytest

from mirage.commands.builtin.generic.program import (
    prepare_program,
    program_file_refusal,
    read_program_file,
)
from mirage.io.types import IOResult, materialize
from mirage.types import FileStat, FileType, PathSpec


def _typed(raw: str) -> PathSpec:
    virtual = raw if raw.startswith("/") else "/" + raw
    return PathSpec(
        virtual=virtual,
        directory="/",
        vfs_path="",
        resolved=True,
        raw_path=raw,
    )


async def _no_dispatch(op, path):
    raise AssertionError(f"stdin only, but {op} {path} was dispatched")


@pytest.mark.asyncio
async def test_rg_pattern_file_from_stdin_lowers_to_regexp():
    texts, flags, rest, error = await prepare_program(
        "rg", ["/in"], {"file": [_typed("-")]}, b"a\nb\n", _no_dispatch
    )
    assert error is None
    assert (texts, flags) == (["/in"], {"file": [], "regexp": ["a\nb"]})
    assert await materialize(rest) == b""


@pytest.mark.asyncio
async def test_grep_exclude_from_trims_trailing_ascii_whitespace():
    _, flags, _, error = await prepare_program(
        "grep",
        ["/in"],
        {"exclude_from": [_typed("-")]},
        "*.log \t\v\f\r\n \t\n\tkeep\u00a0\n".encode(),
        _no_dispatch,
    )
    assert error is None
    assert flags["exclude_from"] == ["*.log", "\tkeep\u00a0"]


@pytest.mark.asyncio
async def test_grep_exclude_from_reads_a_long_run_of_tabs():
    _, flags, _, _ = await prepare_program(
        "grep",
        ["/in"],
        {"exclude_from": [_typed("-")]},
        b"\t" * 200_000 + b"x",
        _no_dispatch,
    )
    assert len(flags["exclude_from"][0]) == 200_001


@pytest.mark.asyncio
@pytest.mark.parametrize("name,data", [("sed", b""), ("grep", None)])
async def test_a_directory_program_file_is_read_as_the_command_reads_it(
    name, data
):
    # sed 4.9 reads a directory as an empty script; everyone else fails
    # its read, which the stat tells from a keyed store's plain miss.

    async def dispatch(op, path, **kwargs):
        assert op == "stat", f"{op} {path.virtual} was dispatched"
        return FileStat(name="dir", type=FileType.DIRECTORY), IOResult()

    if data is None:
        with pytest.raises(IsADirectoryError):
            await read_program_file(name, _typed("dir"), dispatch)
    else:
        assert await read_program_file(name, _typed("dir"), dispatch) == data


def test_a_program_file_refusal_without_a_posix_phrase_names_the_error():
    line, code = program_file_refusal(
        "sed", _typed("p.sed"), OSError("backend exploded")
    )
    assert (line, code) == (
        "sed: couldn't open file p.sed: backend exploded\n",
        4,
    )
