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

import dataclasses

import pytest

from mirage import Action, CommandContext, Policy
from mirage.policy import Ask, Outcome
from mirage.policy.decisions import Decisions
from mirage.policy.types import HandOff, Occurrence, Scope
from mirage.shell.constants import NESTING_MAX
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


async def _run(line: str) -> tuple[str, str, int]:
    ws = Workspace({"/r/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        io = await ws.shell(line)
        return await io.stdout_str(), await io.stderr_str(), io.exit_code
    finally:
        await ws.close()


def _refused(name: str, limit: int) -> str:
    return (
        f"environment: line 1: {name}: "
        f"maximum function nesting level exceeded ({limit})\n"
    )


@pytest.mark.asyncio
async def test_a_call_past_the_limit_abandons_the_line():
    out, err, code = await _run(
        'f() { echo "d$1"; f $(($1+1)); }; f 1; echo same-line'
    )
    assert out.split() == [f"d{n}" for n in range(1, NESTING_MAX + 1)]
    assert err == _refused("f", NESTING_MAX)
    assert code == 1


@pytest.mark.asyncio
async def test_substitution_recursion_stops_at_the_limit():
    out, err, code = await _run('f() { echo $(f); }; f; echo "next $?"')
    assert (out, err, code) == ("\nnext 0\n", _refused("f", NESTING_MAX), 0)


@pytest.mark.asyncio
async def test_funcnest_lowers_the_limit():
    out, err, code = await _run(
        'FUNCNEST=" +2 "; f() { echo "d$1"; f $(($1+1)); }; f 1'
    )
    assert (out, err, code) == ("d1\nd2\n", _refused("f", 2), 1)


@pytest.mark.asyncio
@pytest.mark.parametrize("value", ["100", "0", "-1", "3x", "", "9" * 5000])
async def test_funcnest_never_raises_the_limit(value: str):
    _, err, code = await _run(f'FUNCNEST="{value}"; f() {{ f; }}; f')
    assert (err, code) == (_refused("f", NESTING_MAX), 1)


@pytest.mark.asyncio
async def test_a_sourced_file_is_not_a_function_level():
    out, err, code = await _run(
        "echo g > /r/s.sh; FUNCNEST=2; g() { echo g; }; f() { source /r/s.sh; }; f"
    )
    assert (out, err, code) == ("g\n", "", 0)


class _AskTouch(Policy):
    async def pre_command(self, ctx: CommandContext) -> Action | None:
        return Ask("touch") if ctx.command == "touch" else None


def _place(at: Occurrence | None) -> list[str]:
    texts = []
    while at is not None:
        texts.append(at.source[at.start : at.end])
        at = at.parent
    return texts


def _under(handed: HandOff | None) -> list[str | None]:
    origins: list[str | None] = []
    while handed is not None:
        at = handed.origin
        origins.append(None if at is None else at.source[at.start : at.end])
        handed = handed.parent
    return origins


async def _judged(
    line: str, monkeypatch: pytest.MonkeyPatch
) -> tuple[list[str], list[tuple[str, list[str], list[str | None]]]]:
    """Run ``line`` with every ``touch`` asked about once, and report the
    asks and, for each time the ledger judged one, where it stood and the
    origins of the hand-offs it was judged under, innermost first.

    Args:
        line (str): the line to run.
        monkeypatch (pytest.MonkeyPatch): wraps the ledger's resolve.
    """
    asks: list[str] = []
    judged: list[tuple[str, list[str], list[str | None]]] = []
    resolve = Decisions.resolve

    async def recorded(self, ctx, ask, cancel=None, claimant=None):
        assert claimant is not None
        judged.append(
            (
                " ".join(ctx.argv),
                _place(claimant.occurrence),
                _under(claimant.line),
            )
        )
        return await resolve(self, ctx, ask, cancel, claimant)

    async def on_ask(record):
        asks.append(" ".join(record.argv))
        return dataclasses.replace(
            record, outcome=Outcome.ALLOW, scope=Scope.ONCE
        )

    monkeypatch.setattr(Decisions, "resolve", recorded)
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        policies=[_AskTouch()],
        on_ask=on_ask,
    )
    try:
        await ws.shell(line)
    finally:
        await ws.close()
    return asks, judged


@pytest.mark.asyncio
async def test_a_return_action_set_in_a_body_is_judged_like_the_body(
    monkeypatch,
):
    body = "f() { trap 'touch /data/r' RETURN; touch /data/b; }"
    asks, judged = await _judged(f"{body}; f; f", monkeypatch)
    assert asks == ["/data/b", "/data/r"]
    assert (
        judged
        == [
            ("/data/b", ["touch /data/b", body], [body, None]),
            ("/data/r", ["touch /data/r"], [None, body, None]),
        ]
        * 2
    )


@pytest.mark.asyncio
async def test_an_err_action_a_body_fires_is_judged_under_the_body(
    monkeypatch,
):
    body = "f() { false; }"
    asks, judged = await _judged(
        f"set -E; trap 'touch /data/e' ERR; {body}; f; f", monkeypatch
    )
    assert asks == ["/data/e"]
    assert (
        judged
        == [
            ("/data/e", ["touch /data/e"], [None, body, None]),
            ("/data/e", ["touch /data/e"], [None, None]),
        ]
        * 2
    )


@pytest.mark.asyncio
async def test_an_err_action_inside_an_if_stands_where_the_body_one_does(
    monkeypatch,
):
    body = "f() { false; if :; then false; fi; }"
    asks, judged = await _judged(
        f"set -E; trap 'touch /data/e' ERR; {body}; f; f", monkeypatch
    )
    assert asks == ["/data/e"]
    assert (
        judged
        == [
            ("/data/e", ["touch /data/e"], [None, body, None]),
            ("/data/e", ["touch /data/e"], [None, body, None]),
            ("/data/e", ["touch /data/e"], [None, None]),
        ]
        * 2
    )


@pytest.mark.asyncio
async def test_a_trap_outside_any_function_is_judged_on_the_line(
    monkeypatch,
):
    asks, judged = await _judged(
        "trap 'touch /data/e' ERR; f() { :; }; f; false; false", monkeypatch
    )
    assert asks == ["/data/e"]
    assert judged == [("/data/e", ["touch /data/e"], [None, None])] * 2


@pytest.mark.asyncio
async def test_one_return_action_text_set_by_two_functions_asks_once_for_both(
    monkeypatch,
):
    asks, judged = await _judged(
        "f() { trap 'touch /data/r' RETURN; }; "
        "g() { trap 'touch /data/r' RETURN; }; f; g",
        monkeypatch,
    )
    assert asks == ["/data/r"]
    assert [where for _, where, _ in judged] == [["touch /data/r"]] * 2
