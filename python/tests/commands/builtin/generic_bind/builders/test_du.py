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

from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.generic_bind.builders.du import WalkBudget, du
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.parser import parse_command, parse_to_kwargs
from mirage.io.stream import materialize
from mirage.types import FileStat, FileType, PathSpec

TREE = {
    "/db": ["/db/a.txt", "/db/sub"],
    "/db/sub": ["/db/sub/b.txt"],
}
SIZES = {"/db/a.txt": 3, "/db/sub/b.txt": 2}


def _ops(max_du_entries: int | None = None) -> CommandIO:

    async def readdir(_accessor, path, _index=None):
        return TREE.get(path.virtual.rstrip("/") or "/", [])

    async def stat(_accessor, path, _index=None):
        virtual = path.virtual
        if virtual in TREE:
            return FileStat(name=virtual, type=FileType.DIRECTORY)
        if virtual in SIZES:
            return FileStat(name=virtual, size=SIZES[virtual])
        raise FileNotFoundError(virtual)

    async def read_bytes(_accessor, _path, _index=None):
        return b""

    return CommandIO(readdir=readdir,
                     read_bytes=read_bytes,
                     read_stream=read_bytes,
                     stat=stat,
                     is_mounted=lambda _a: True,
                     max_du_entries=max_du_entries)


def _spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=virtual.lstrip("/"))


async def _run(ops: CommandIO, path: str, **flags) -> tuple[str, int, str]:
    stream, io = await du(ops, object(), [_spec(path)], [],
                          CommandOpts(flags={**flags}))
    return ((await
             materialize(stream)).decode(), io.exit_code, (io.stderr
                                                           or b"").decode())


def test_walk_budget_stops_once_spent():
    budget = WalkBudget(2)
    assert budget.spend() is True
    assert budget.spend() is True
    assert budget.spend() is False
    assert budget.hit is True


def test_walk_budget_is_unbounded_when_none():
    budget = WalkBudget(None)
    for _ in range(100):
        assert budget.spend() is True
    assert budget.hit is False


@pytest.mark.asyncio
async def test_fallback_walk_sums_a_tree():
    out, code, err = await _run(_ops(), "/db")
    assert out == "2\t/db/sub\n5\t/db\n"
    assert code == 0
    assert err == ""


@pytest.mark.asyncio
async def test_fallback_walk_lists_entries_for_a():
    out, _, _ = await _run(_ops(), "/db", a=True)
    assert out == ("3\t/db/a.txt\n"
                   "2\t/db/sub/b.txt\n"
                   "2\t/db/sub\n"
                   "5\t/db\n")


@pytest.mark.asyncio
async def test_missing_operand_is_reported_and_exits_one():
    """GNU names the operand it could not stat and still prints the rest."""
    ops = _ops()
    stream, io = await du(ops, object(),
                          [_spec('/nope'), _spec('/db')], [], CommandOpts())
    out = (await materialize(stream)).decode()
    assert out == "2\t/db/sub\n5\t/db\n"
    assert io.exit_code == 1
    assert (io.stderr or b"").decode() == (
        "du: cannot access '/nope': No such file or directory\n")


@pytest.mark.asyncio
async def test_no_operand_walks_the_working_directory():
    """GNU du with no operand summarises '.'; mirage uses the session cwd."""
    stream, io = await du(_ops(), object(), [], [], CommandOpts(cwd='/db'))
    assert (await materialize(stream)).decode() == "2\t/db/sub\n5\t/db\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_d_is_an_alias_for_max_depth():
    # The alias is the parser's: both spellings compile onto the one
    # canonical dest, so the builder never sees a separate `d`.
    short = parse_to_kwargs(parse_command(SPECS["du"], ["-d", "0"], cwd="/"))
    long = parse_to_kwargs(
        parse_command(SPECS["du"], ["--max-depth", "0"], cwd="/"))
    assert short == long == {"max_depth": "0"}
    out, _, _ = await _run(_ops(), "/db", **short)
    assert out == "5\t/db\n"


@pytest.mark.asyncio
async def test_summarize_with_all_is_a_usage_error():
    with pytest.raises(UsageError) as excinfo:
        await _run(_ops(), "/db", s=True, a=True)
    assert excinfo.value.exit_code == 1
    assert "cannot both summarize" in str(excinfo.value)


@pytest.mark.asyncio
async def test_exhausted_budget_reports_partial_output_and_exits_one():
    """A tree bigger than the cap must not report a wrong size silently."""
    out, code, err = await _run(_ops(max_du_entries=1), "/db")
    assert code == 1
    assert "incomplete" in err
    assert out.endswith("\t/db\n")


@pytest.mark.asyncio
async def test_budget_is_shared_across_operands():
    ops = _ops(max_du_entries=1)
    stream, io = await du(ops, object(),
                          [_spec('/db'), _spec('/db/sub')], [], CommandOpts())
    assert io.exit_code == 1
    assert len((await materialize(stream)).decode().splitlines()) == 2
