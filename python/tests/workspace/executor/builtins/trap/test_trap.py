import pytest

from mirage.workspace.executor.builtins.trap.trap import event_of, handle_trap
from mirage.workspace.executor.builtins.trap.types import TrapEvent
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
        ("TERM", TrapEvent.OTHER),
        ("sigint", TrapEvent.OTHER),
        ("ERR", TrapEvent.ERR),
        ("return", TrapEvent.RETURN),
        ("DEBUG", TrapEvent.OTHER),
        ("15", TrapEvent.OTHER),
        ("RTMIN+3", TrapEvent.OTHER),
        ("SIGEXIT", None),
        ("65", None),
        ("FOO", None),
        # bash 5.2 takes the names `trap -l` lists and no other:
        # IO and STKFLT, but not the IOT, CLD or POLL timeout also takes.
        ("IO", TrapEvent.OTHER),
        ("sigstkflt", TrapEvent.OTHER),
        ("IOT", None),
        ("SIGCLD", None),
        ("POLL", None),
    ],
)
def test_event_of_reads_specs_as_bash_does(spec, event):
    assert event_of(spec) is event


def test_event_of_reads_numbers_past_the_int_digit_limit():
    # bash 5.2 reads 5,000 leading zeros as nothing, and 5,000 digits as
    # no signal.
    assert event_of("0" * 5000) is TrapEvent.EXIT
    assert event_of("0" * 5000 + "9") is TrapEvent.OTHER
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
