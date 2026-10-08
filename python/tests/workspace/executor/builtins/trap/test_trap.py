import pytest

from mirage.workspace.executor.builtins.trap.trap import event_of, handle_trap
from mirage.workspace.executor.builtins.trap.types import TrapEvent
from mirage.workspace.session.session import SessionState

USAGE = b"trap: usage: trap [-lp] [[arg] signal_spec ...]\n"


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
    ],
)
def test_event_of_reads_specs_as_bash_does(spec, event):
    assert event_of(spec) is event


@pytest.mark.asyncio
async def test_registers_and_lists_with_bash_quoting():
    session = make_session()
    _, io, _ = await handle_trap(["printf '%s' x", "EXIT"], session)
    assert io.exit_code == 0
    assert session.exit_trap == "printf '%s' x"
    out, io, _ = await handle_trap(["-p", "EXIT", "0"], session)
    row = b"trap -- 'printf '\\''%s'\\'' x' EXIT\n"
    assert out == row * 2
    out, _, _ = await handle_trap([], session)
    assert out == row


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
async def test_empty_action_is_kept_and_listed():
    session = make_session()
    await handle_trap(["", "EXIT"], session)
    out, _, _ = await handle_trap(["-p"], session)
    assert out == b"trap -- '' EXIT\n"


@pytest.mark.asyncio
async def test_registering_takes_ownership_from_the_parent():
    session = make_session()
    session.exit_trap = "echo parent"
    session.exit_trap_inherited = True
    await handle_trap(["echo child", "EXIT"], session)
    assert session.exit_trap == "echo child"
    assert session.exit_trap_inherited is False


@pytest.mark.asyncio
async def test_lone_action_is_a_usage_error():
    _, io, _ = await handle_trap(["echo BAD"], make_session())
    assert io.exit_code == 2
    assert io.stderr == USAGE


@pytest.mark.asyncio
async def test_invalid_option_prints_usage():
    _, io, _ = await handle_trap(["-z"], make_session())
    assert io.exit_code == 2
    assert io.stderr == b"bash: trap: -z: invalid option\n" + USAGE


@pytest.mark.asyncio
async def test_signal_list_is_refused():
    _, io, _ = await handle_trap(["-l"], make_session())
    assert io.exit_code == 2
    assert io.stderr == b"mirage: trap: -l: not supported\n"


@pytest.mark.asyncio
async def test_other_events_are_refused_and_exit_still_set():
    session = make_session()
    _, io, _ = await handle_trap(["echo x", "TERM", "FOO", "EXIT"], session)
    assert io.exit_code == 1
    assert io.stderr == (
        b"mirage: trap: TERM: not supported\n"
        b"bash: trap: FOO: invalid signal specification\n"
    )
    assert session.exit_trap == "echo x"


@pytest.mark.asyncio
async def test_resetting_another_event_is_a_no_op():
    _, io, _ = await handle_trap(["-", "TERM"], make_session())
    assert io.exit_code == 0
