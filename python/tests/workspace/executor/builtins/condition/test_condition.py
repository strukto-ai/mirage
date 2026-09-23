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

from typing import Any, cast

import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.io import IOResult
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.workspace.executor.builtins.condition import CondContext, eval_flat
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import SessionState


class _StubNamespace:
    """Namespace stand-in with no symlinks."""

    def symlink_targets(self) -> dict[str, str]:
        return {}

    def is_link(self, path: str) -> bool:
        return False


class _StubSession:
    """Session stand-in exposing only what the evaluator touches."""

    cwd = "/data"
    env: dict[str, str] = {}
    arrays: dict[str, list[str]] = {}


class _PrefixStoreDispatch:
    """Mimics a prefix store (s3/gridfs/hf/nextcloud): stat never sees
    directories and readdir answers a missing path with a listing
    instead of raising.

    Args:
        listing (list[str]): what readdir returns for every path.
    """

    def __init__(self, listing: list[str]) -> None:
        self.listing = listing

    async def __call__(self, op: str, scope: PathSpec,
                       **kwargs: Any) -> tuple[Any, IOResult]:
        if op == "stat":
            raise FileNotFoundError(scope.virtual)
        if op == "readdir":
            return self.listing, IOResult()
        raise AssertionError(op)


class _UnknownSizeDispatch:
    """Mimics an API backend (dropbox/gdrive/box) whose stat reports
    size-unknown for a regular file.

    Args:
        content (bytes): what read returns.
    """

    def __init__(self, content: bytes) -> None:
        self.content = content

    async def __call__(self, op: str, scope: PathSpec,
                       **kwargs: Any) -> tuple[Any, IOResult]:
        if op == "stat":
            stat = FileStat(name="x",
                            size=None,
                            type=FileType.FILE,
                            content=ContentType.TEXT)
            return stat, IOResult()
        if op == "read":
            return self.content, IOResult()
        raise AssertionError(op)


def _stub_ctx(dispatch: Any) -> CondContext:
    """Build a CondContext around a stub dispatch.

    Args:
        dispatch (Any): fake op dispatcher.
    """
    return CondContext(dispatch=dispatch,
                       namespace=cast(Namespace, _StubNamespace()),
                       session=cast(SessionState, _StubSession()),
                       name="test")


async def _workspace() -> Workspace:
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("mkdir -p /data/sub")
    await ws.shell("tee /data/plain.txt > /dev/null", stdin=b"y\n")
    await ws.shell("cd /data")
    return ws


async def _rc(ws: Workspace, cmd: str) -> int:
    io = await ws.shell(cmd)
    return io.exit_code


@pytest.mark.asyncio
async def test_f_relative_resolves_against_cwd():
    ws = await _workspace()
    assert await _rc(ws, "test -f plain.txt") == 0


@pytest.mark.asyncio
async def test_f_relative_missing():
    ws = await _workspace()
    assert await _rc(ws, "test -f missing.txt") == 1


@pytest.mark.asyncio
async def test_f_relative_with_dotdot():
    ws = await _workspace()
    await ws.shell("cd /data/sub")
    assert await _rc(ws, "test -f ../plain.txt") == 0


@pytest.mark.asyncio
async def test_d_relative_resolves_against_cwd():
    ws = await _workspace()
    assert await _rc(ws, "test -d sub") == 0


@pytest.mark.asyncio
async def test_d_relative_missing():
    ws = await _workspace()
    assert await _rc(ws, "test -d nosuch") == 1


@pytest.mark.asyncio
async def test_f_absolute_unchanged():
    ws = await _workspace()
    assert await _rc(ws, "test -f /data/plain.txt") == 0


@pytest.mark.asyncio
async def test_f_empty_operand_false():
    ws = await _workspace()
    assert await _rc(ws, 'test -f ""') == 1


@pytest.mark.asyncio
async def test_bracket_form_relative():
    ws = await _workspace()
    assert await _rc(ws, "[ -f plain.txt ]") == 0


@pytest.mark.asyncio
async def test_negation_relative():
    ws = await _workspace()
    assert await _rc(ws, "test ! -f missing.txt") == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("cmd,rc", [
    ("[ -e /data/plain.txt ]", 0),
    ("[ -e /data/sub ]", 0),
    ("[ -e /data/nope ]", 1),
    ("[ -s /data/plain.txt ]", 0),
    ("[ -s /data/nope ]", 1),
    ("[ -f /data/sub ]", 1),
    ("[ -d /data/plain.txt ]", 1),
    ("[ -r /data/plain.txt ]", 0),
    ("[ -w /data/plain.txt ]", 0),
    ("[ -x /data/plain.txt ]", 1),
    ("[ -x /data/sub ]", 0),
    ("[ -r /data/nope ]", 1),
])
async def test_file_unary_operators(cmd: str, rc: int):
    ws = await _workspace()
    assert await _rc(ws, cmd) == rc


@pytest.mark.asyncio
async def test_s_empty_file_false():
    ws = await _workspace()
    await ws.shell("printf '' > /data/zero.txt")
    assert await _rc(ws, "[ -s /data/zero.txt ]") == 1


@pytest.mark.asyncio
async def test_e_missing_on_prefix_store_false():
    ctx = _stub_ctx(_PrefixStoreDispatch([]))
    assert await eval_flat(ctx, ["-e", "/data/znope"]) is False
    assert await eval_flat(ctx, ["-d", "/data/znope"]) is False
    assert await eval_flat(ctx, ["-s", "/data/znope"]) is False


@pytest.mark.asyncio
async def test_d_nonempty_listing_on_prefix_store_true():
    ctx = _stub_ctx(_PrefixStoreDispatch(["a.txt"]))
    assert await eval_flat(ctx, ["-e", "/data/sub"]) is True
    assert await eval_flat(ctx, ["-d", "/data/sub"]) is True


@pytest.mark.asyncio
async def test_s_unknown_size_reads_content():
    empty = _stub_ctx(_UnknownSizeDispatch(b""))
    assert await eval_flat(empty, ["-s", "/data/zte.txt"]) is False
    full = _stub_ctx(_UnknownSizeDispatch(b"x"))
    assert await eval_flat(full, ["-s", "/data/zt.txt"]) is True


@pytest.mark.asyncio
async def test_e_unknown_size_no_read():
    # -e/-f must answer from stat alone; only -s may hydrate.
    ctx = _stub_ctx(_UnknownSizeDispatch(b""))
    assert await eval_flat(ctx, ["-e", "/data/zte.txt"]) is True
    assert await eval_flat(ctx, ["-f", "/data/zte.txt"]) is True


@pytest.mark.asyncio
async def test_x_true_after_chmod():
    ws = await _workspace()
    await ws.shell("chmod +x /data/plain.txt")
    assert await _rc(ws, "[ -x /data/plain.txt ]") == 0


@pytest.mark.asyncio
async def test_symlink_L_and_dangling():
    ws = await _workspace()
    await ws.shell("ln -s /data/plain.txt /data/zl && ln -s /data/nope "
                   "/data/zd")
    assert await _rc(ws, "[ -L /data/zl ]") == 0
    assert await _rc(ws, "[ -h /data/zl ]") == 0
    assert await _rc(ws, "[ -L /data/plain.txt ]") == 1
    assert await _rc(ws, "[ -L /data/zd ]") == 0
    assert await _rc(ws, "[ -e /data/zd ]") == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("cmd,rc", [
    ("[ a = a ]", 0),
    ("[ a = b ]", 1),
    ("[ a == a ]", 0),
    ("[ a != b ]", 0),
    ("[ abc = a* ]", 1),
    ("[ 1 -eq 1 ]", 0),
    ("[ 010 -eq 10 ]", 0),
    ("[ -1 -lt 0 ]", 0),
    ("[ -n x -a -n y ]", 0),
    ("[ -n x -a -z x ]", 1),
    ("[ -z x -o -n y ]", 0),
    ("[ -z x -o -z y ]", 1),
    ("[ -z x -o -n x -a -z y ]", 1),
    ("[ a = a -a b = b ]", 0),
    ("[ a = a -a b = c ]", 1),
    ("[ ! -e /data/nope ]", 0),
    ("[ ! a = a ]", 1),
    ("[ ! '' ]", 0),
    ("[ hello ]", 0),
    ("[ '' ]", 1),
    ("[ ]", 1),
    ("[ -e ]", 0),
    ("test hello", 0),
    ("test", 1),
])
async def test_flat_arity_and_combinators(cmd: str, rc: int):
    ws = await _workspace()
    assert await _rc(ws, cmd) == rc


@pytest.mark.asyncio
@pytest.mark.parametrize("cmd,message", [
    ("[ x -bogus y ]", "[: -bogus: binary operator expected"),
    ("[ -bogus x ]", "[: -bogus: unary operator expected"),
    ("[ a = b c ]", "[: too many arguments"),
    ("[ x -eq 1 ]", "[: x: integer expression expected"),
    ("[ 1 -eq x ]", "[: x: integer expression expected"),
    ("test x -eq 1", "test: x: integer expression expected"),
])
async def test_flat_errors_exit_two(cmd: str, message: str):
    ws = await _workspace()
    io = await ws.shell(cmd)
    assert io.exit_code == 2
    assert message in await io.stderr_str()


@pytest.mark.asyncio
@pytest.mark.parametrize("cmd,rc", [
    ("[[ abc == a* ]]", 0),
    ("[[ abc == b* ]]", 1),
    ("[[ abc == 'a*' ]]", 1),
    ("[[ 'a*' == 'a*' ]]", 0),
    ("[[ ab == a? ]]", 0),
    ("[[ abc == a? ]]", 1),
    ("[[ abc == [ab]* ]]", 0),
    ("[[ abc != a* ]]", 1),
    ("[[ abc != b* ]]", 0),
    ("[[ abc =~ ^a.c$ ]]", 0),
    ("[[ abc =~ b ]]", 0),
    ("[[ abc =~ ^b ]]", 1),
    ("[[ 'ab cd' =~ 'b c' ]]", 0),
    ("[[ axc =~ 'a.c' ]]", 1),
    ("[[ -n x && -n y ]]", 0),
    ("[[ -n x && -z x ]]", 1),
    ("[[ -z x || -n y ]]", 0),
    ("[[ ! -n x ]]", 1),
    ("[[ ( -z x || -n y ) && -n z ]]", 0),
    ("[[ a < b ]]", 0),
    ("[[ b < a ]]", 1),
    ("[[ b > a ]]", 0),
    ("[[ 1 -lt 2 ]]", 0),
    ("[[ 1+1 -eq 2 ]]", 0),
    ("[[ zqx9 -eq 0 ]]", 0),
    ("[[ -e /data/plain.txt ]]", 0),
    ("[[ -f /data/sub ]]", 1),
])
async def test_double_bracket_semantics(cmd: str, rc: int):
    ws = await _workspace()
    assert await _rc(ws, cmd) == rc


@pytest.mark.asyncio
async def test_double_bracket_pattern_from_variable():
    ws = await _workspace()
    io = await ws.shell("p='a*'; [[ abc == $p ]]; echo $?;"
                        " [[ abc == \"$p\" ]]; echo $?")
    assert await io.stdout_str() == "0\n1\n"


@pytest.mark.asyncio
async def test_double_bracket_arith_variable():
    ws = await _workspace()
    io = await ws.shell("n=3; [[ n -eq 3 ]]; echo $?")
    assert await io.stdout_str() == "0\n"


@pytest.mark.asyncio
async def test_double_bracket_no_word_splitting():
    ws = await _workspace()
    io = await ws.shell("v='a b'; [[ $v == 'a b' ]]; echo $?")
    assert await io.stdout_str() == "0\n"


@pytest.mark.asyncio
async def test_single_bracket_word_splits_expansion():
    ws = await _workspace()
    io = await ws.shell("v='a b'; [ $v = 'a b' ]; echo $?")
    assert io.exit_code == 0
    assert await io.stdout_str() == "2\n"
    assert "too many arguments" in await io.stderr_str()


@pytest.mark.asyncio
async def test_double_bracket_rematch():
    ws = await _workspace()
    io = await ws.shell("[[ abc =~ b. ]] && echo m:${BASH_REMATCH[0]}")
    assert await io.stdout_str() == "m:bc\n"


@pytest.mark.asyncio
async def test_double_bracket_bad_operator_kills_line():
    ws = await _workspace()
    io = await ws.shell("[[ a -bogus b ]]; echo after")
    assert io.exit_code == 2
    assert "conditional binary operator expected" in await io.stderr_str()
    assert await io.stdout_str() == ""


@pytest.mark.asyncio
async def test_unsupported_operator_fails_loudly():
    ws = await _workspace()
    io = await ws.shell("[ -p /data/plain.txt ]")
    assert io.exit_code == 2
    assert "[: -p: unsupported operator" in await io.stderr_str()


@pytest.mark.asyncio
async def test_if_integration():
    ws = await _workspace()
    io = await ws.shell(
        "if [ -e /data/plain.txt ]; then echo yes; else echo no; fi")
    assert await io.stdout_str() == "yes\n"
    io = await ws.shell("if [[ plain.txt == *.txt ]]; then echo yes; fi")
    assert await io.stdout_str() == "yes\n"
