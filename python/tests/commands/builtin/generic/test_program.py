import json
from pathlib import Path

import pytest

from mirage.commands.builtin.generic.program import (RG_STDIN_REREAD,
                                                     RG_STDIN_SEARCHED,
                                                     prepare_program)
from mirage.io.types import materialize
from mirage.types import PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

CORPUS = Path(
    __file__).resolve().parents[5] / "integ/crossmount/program/files.json"
CASES = json.loads(CORPUS.read_text())["cases"]


@pytest.mark.asyncio
@pytest.mark.parametrize("case", CASES, ids=[case["id"] for case in CASES])
async def test_program_file_routing(case):
    ws = Workspace({"/data": RAMVFS(), "/data2": RAMVFS()}, mode="exec")
    try:
        result = await ws.shell(case["command"])
        expected = case["expect"]
        assert (result.exit_code, result.stdout or b"", result.stderr
                or b"") == (expected["exit"], expected["stdout"].encode(),
                            expected["stderr"].encode())
    finally:
        await ws.close()


def _typed(raw: str) -> PathSpec:
    virtual = raw if raw.startswith("/") else "/" + raw
    return PathSpec(virtual=virtual,
                    directory="/",
                    vfs_path="",
                    resolved=True,
                    raw_path=raw)


async def _no_dispatch(op, path):
    raise AssertionError(f"stdin only, but {op} {path} was dispatched")


@pytest.mark.asyncio
async def test_rg_pattern_file_from_stdin_lowers_to_regexp():
    texts, flags, rest, error = await prepare_program("rg", ["/in"],
                                                      {"file": [_typed("-")]},
                                                      b"a\nb\n", _no_dispatch)
    assert error is None
    assert (texts, flags) == (["/in"], {"file": [], "regexp": ["a\nb"]})
    assert await materialize(rest) == b""


@pytest.mark.asyncio
async def test_rg_refuses_a_second_dash_pattern_file():
    # ripgrep 14.1.1: `rg -f - -f -` reads stdin once and refuses the
    # second before any operand is looked at.
    *_, error = await prepare_program(
        "rg", [], {"file": [_typed("-"), _typed("-")]}, b"a\n", _no_dispatch,
        [_typed("-")])
    assert error is not None
    assert (error.exit_code, error.stderr) == (2, RG_STDIN_REREAD.encode())


@pytest.mark.asyncio
async def test_rg_refuses_a_dash_operand_after_dash_pattern_file():
    *_, error = await prepare_program(
        "rg", [], {"file": [_typed("-")]}, b"a\n", _no_dispatch,
        [_typed("/in"), _typed("-")])
    assert error is not None
    assert (error.exit_code, error.stderr) == (2, RG_STDIN_SEARCHED.encode())


@pytest.mark.asyncio
async def test_rg_dev_stdin_pattern_file_takes_no_dash():
    # ripgrep reads `-f /dev/stdin` as a file, so a `-` operand after it
    # searches what is left of stdin (nothing) rather than being refused.
    _, flags, rest, error = await prepare_program(
        "rg", [], {"file": [_typed("/dev/stdin")]}, b"a\n", _no_dispatch,
        [_typed("-")])
    assert error is None
    assert flags == {"file": [], "regexp": ["a"]}
    assert await materialize(rest) == b""


@pytest.mark.asyncio
async def test_grep_reads_a_dash_pattern_file_twice_without_refusing():
    # GNU grep 3.11 reads the second `-f -` as an empty pattern file.
    _, flags, _, error = await prepare_program("grep", [], {
        "file": [_typed("-"), _typed("-")],
        "e": []
    }, b"a\n", _no_dispatch, [_typed("-")])
    assert error is None
    assert flags == {"file": [], "e": ["a"]}
