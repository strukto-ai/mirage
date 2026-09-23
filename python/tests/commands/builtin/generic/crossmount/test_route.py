import pytest

from mirage.commands.builtin.generic.crossmount.route import handle_cross_mount
from mirage.commands.builtin.generic.crossmount.types import Strategy
from mirage.io import IOResult
from mirage.types import PathSpec

CALLS: list[tuple[str, str]] = []


def _path(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory="/",
                    vfs_path=virtual.lstrip("/"),
                    raw_path=virtual)


async def _dispatch(*args: object, **kwargs: object) -> None:
    raise AssertionError("dispatch is RELAY-only and must not be called here")


async def _run_single(cmd_name: str, scope: PathSpec, *args: object,
                      **kwargs: object) -> IOResult:
    raise AssertionError("run_single must not be called by these fakes")


def _pick(strategy: Strategy):

    def strategy_for(cmd_name: str, flags: dict) -> Strategy:
        return strategy

    return strategy_for


def _runner(label: str):

    async def run(cmd_name: str, *args: object, **kwargs: object):
        CALLS.append((label, cmd_name))
        return None, IOResult(exit_code=0)

    return run


@pytest.fixture(autouse=True)
def _reset_calls():
    CALLS.clear()


@pytest.mark.asyncio
@pytest.mark.parametrize("strategy,runner", [
    (Strategy.RELAY, "run_relay"),
    (Strategy.STREAM, "run_stream"),
    (Strategy.FANOUT, "run_fanout"),
])
async def test_each_strategy_reaches_its_runner(monkeypatch, strategy, runner):
    mod = "mirage.commands.builtin.generic.crossmount.route"
    monkeypatch.setattr(f"{mod}.strategy_for", _pick(strategy))
    for name in ("run_relay", "run_stream", "run_fanout"):
        monkeypatch.setattr(f"{mod}.{name}", _runner(name))
    _, result = await handle_cross_mount("sort", [_path("/a/x")], [], {},
                                         _dispatch, _run_single)
    assert result.exit_code == 0
    assert CALLS == [(runner, "sort")]


def _broken(strategy_exc: Exception):

    def strategy_for(cmd_name: str, flags: dict) -> Strategy:
        raise strategy_exc

    return strategy_for


@pytest.mark.asyncio
async def test_a_filesystem_error_reports_in_the_commands_voice(monkeypatch):
    monkeypatch.setattr(
        "mirage.commands.builtin.generic.crossmount.route.strategy_for",
        _broken(FileNotFoundError("/a/x")))
    _, result = await handle_cross_mount("sort", [_path("/a/x")], [], {},
                                         _dispatch, _run_single)
    # sort's own code for a failed read, not the catch-all 1: GNU sort
    # exits 2 whether the operand is missing or a directory.
    assert result.exit_code == 2
    assert b"sort" in result.stderr
