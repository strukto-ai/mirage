import pytest

from mirage.workspace.executor.builtins.trap.trap import event_of, handle_trap
from mirage.workspace.executor.builtins.trap.types import TrapEvent
from mirage.workspace.executor.traps import start_job_traps
from mirage.workspace.session.session import SessionState


def make_session() -> SessionState:
    return SessionState(session_id="s1")


@pytest.mark.parametrize(
    "spec, event",
    [
        ("EXIT", TrapEvent.EXIT),
        ("exit", TrapEvent.EXIT),
        ("0", TrapEvent.EXIT),
        ("00", TrapEvent.EXIT),
        ("TERM", 15),
        ("sigint", 2),
        ("ERR", TrapEvent.ERR),
        ("return", TrapEvent.RETURN),
        ("DEBUG", TrapEvent.DEBUG),
        ("15", 15),
        ("RTMIN+3", 37),
        ("RTMIN+" + "0" * 5000 + "1", 35),
        ("RTMAX-" + "0" * 5000 + "1", None),
        ("0" * 5000 + "15", 15),
        ("SIGEXIT", None),
        ("65", None),
        ("FOO", None),
        # bash 5.2 takes the names `trap -l` lists and no other:
        # IO and STKFLT, but not the IOT, CLD or POLL timeout also takes.
        ("IO", 29),
        ("sigstkflt", 16),
        ("IOT", None),
        ("SIGCLD", None),
        ("POLL", None),
    ],
)
def test_event_of_reads_specs_as_bash_does(spec, event):
    assert event_of(spec) == event


def test_event_of_reads_numbers_past_the_int_digit_limit():
    # bash 5.2 reads 5,000 leading zeros as nothing, and 5,000 digits as
    # no signal.
    assert event_of("0" * 5000) is TrapEvent.EXIT
    assert event_of("0" * 5000 + "9") == 9
    assert event_of("9" * 5000) is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "args", [["-", "EXIT"], ["EXIT"], ["0"], ["--", "-", "EXIT"]]
)
async def test_reset_forms_clear_the_action(args):
    session = make_session()
    session.exit_trap = "echo x"
    _, io, _ = await handle_trap(args, session)
    assert io.exit_code == 0
    assert session.exit_trap is None


@pytest.mark.asyncio
async def test_resetting_another_event_is_a_no_op():
    _, io, _ = await handle_trap(["-", "TERM"], make_session())
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_signal_actions_list_by_number_between_exit_and_err():
    session = make_session()
    for args in (["t", "TERM"], ["h", "1"], [":", "EXIT"], ["e", "ERR"]):
        await handle_trap(args, session)
    out, io, _ = await handle_trap(["-p"], session)
    assert io.exit_code == 0
    assert out == (
        b"trap -- ':' EXIT\n"
        b"trap -- 'h' SIGHUP\n"
        b"trap -- 't' SIGTERM\n"
        b"trap -- 'e' ERR\n"
    )


@pytest.mark.asyncio
async def test_a_signal_ignored_as_the_shell_started_stays_ignored():
    session = make_session()
    session.signal_traps = {2: ""}
    session.entry_ignored = frozenset({2})
    await handle_trap(["echo int", "INT"], session)
    await handle_trap(["-", "INT"], session)
    assert session.signal_traps == {2: ""}


@pytest.mark.asyncio
async def test_a_jobs_int_ignore_lists_until_it_resets_it():
    session = make_session()
    start_job_traps(session, True)
    out, _, _ = await handle_trap(["-p"], session)
    assert out == b"trap -- '' SIGINT\n"
    await handle_trap(["-", "INT"], session)
    assert (session.signal_traps, session.job_ignored) == ({}, frozenset())


def test_catch_signal_takes_caught_and_ignored_signals_only():
    session = make_session()
    session.signal_traps = {15: "echo t", 10: ""}
    assert session.catch_signal(15, 1) is True
    assert session.pending_signals == {15}
    assert session.catch_signal(10, 1) is False
    assert session.catch_signal(2, 1) is None
    session.process_id = 7
    assert session.catch_signal(15, 1) is None
    session.signal_traps_inherited = True
    assert session.catch_signal(15, 7) is None
    assert session.catch_signal(10, 7) is False
