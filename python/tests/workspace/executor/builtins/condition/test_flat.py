from typing import cast

import pytest

from mirage.workspace.executor.builtins.condition import (CondContext,
                                                          CondError, eval_flat)
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import Session


class _StubNamespace:
    """Namespace stand-in with no symlinks."""

    def symlink_targets(self) -> dict[str, str]:
        return {}

    def is_link(self, path: str) -> bool:
        return False


class _StubSession:
    """Session stand-in exposing only what the evaluator touches."""

    cwd = "/data"


def _ctx() -> CondContext:
    return CondContext(dispatch=None,
                       namespace=cast(Namespace, _StubNamespace()),
                       session=cast(Session, _StubSession()),
                       name="test")


@pytest.mark.asyncio
async def test_flat_arity_zero_one_two():
    assert await eval_flat(_ctx(), []) is False
    assert await eval_flat(_ctx(), ["x"]) is True
    assert await eval_flat(_ctx(), [""]) is False
    assert await eval_flat(_ctx(), ["-z", ""]) is True
    assert await eval_flat(_ctx(), ["-n", "abc"]) is True
    assert await eval_flat(_ctx(), ["!", ""]) is True


@pytest.mark.asyncio
async def test_flat_binary_string_and_integer_operators():
    assert await eval_flat(_ctx(), ["a", "=", "a"]) is True
    assert await eval_flat(_ctx(), ["a", "!=", "b"]) is True
    assert await eval_flat(_ctx(), ["3", "-lt", "10"]) is True
    assert await eval_flat(_ctx(), ["10", "-le", "3"]) is False
    assert await eval_flat(_ctx(), ["!", "a", "=", "b"]) is True


@pytest.mark.asyncio
async def test_flat_and_or_and_parentheses():
    assert await eval_flat(_ctx(), ["a", "-a", ""]) is False
    assert await eval_flat(_ctx(), ["", "-o", "b"]) is True
    assert await eval_flat(_ctx(), ["(", "a", "=", "a", ")"]) is True


@pytest.mark.asyncio
async def test_flat_reports_a_bad_integer_as_an_error():
    with pytest.raises(CondError):
        await eval_flat(_ctx(), ["x", "-eq", "1"])


@pytest.mark.asyncio
@pytest.mark.parametrize("line,expected", [
    ("[ d/b.txt -nt d/a.txt ]", 0),
    ("[ d/a.txt -nt d/b.txt ]", 1),
    ("[ d/a.txt -ot d/b.txt ]", 0),
    ("[ d/a.txt -ef d/a.txt ]", 0),
    ("[ d/a.txt -ef d/b.txt ]", 1),
    ("[ d/a.txt -nt nope ]", 0),
    ("[ nope -nt d/a.txt ]", 1),
    ("[ nope -ot d/a.txt ]", 0),
    ("[ d/a.txt -ot nope ]", 1),
    ("[ nope -ef nope ]", 1),
    ("[ nope -nt nope ]", 1),
    ("[ l -ef d/a.txt ]", 0),
    ("[ l -nt d/a.txt ]", 1),
    ("[ d -ef d/ ]", 0),
    ("[ ./d/a.txt -ef d/a.txt ]", 0),
    ("[[ d/b.txt -nt d/a.txt ]]", 0),
    ("test d/a.txt -nt d/a.txt", 1),
    ('[ "" -nt d/a.txt ]', 1),
    ('[ d/a.txt -nt "" ]', 0),
    ("[ d/a.txt -ef /w/l ]", 0),
])
async def test_file_pair_operators_match_bash(line, expected):
    # Pinned against GNU bash 5.2: a missing right side makes -nt true,
    # a missing left side makes -ot true, -ef follows symlinks.
    from mirage import MountMode, RAMResource, Workspace
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("mkdir -p /w/d; printf a > /w/d/a.txt; "
                     "touch -d '2020-01-01 00:00:00' /w/d/a.txt; "
                     "printf bb > /w/d/b.txt; ln -s d/a.txt /w/l; cd /w")
    io = await ws.execute(line)
    assert io.exit_code == expected


@pytest.mark.asyncio
async def test_equal_mtimes_are_neither_newer_nor_older():
    from mirage import MountMode, RAMResource, Workspace
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("mkdir -p /w; touch -d '2020-01-01 00:00:00' /w/a /w/b")
    assert (await ws.execute("[ /w/a -nt /w/b ]")).exit_code == 1
    assert (await ws.execute("[ /w/a -ot /w/b ]")).exit_code == 1
