import pytest

from mirage.commands.builtin.utils.identity import (NO_IDENTITY, Identity,
                                                    group_name, identity_from,
                                                    identity_of, owner_name)
from mirage.commands.config import CommandOpts
from mirage.io.types import materialize
from mirage.ops.types import NamespaceView
from mirage.policy.profile import SessionProfile
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.session.session import Session
from mirage.workspace.session.state import session_view


def test_owner_and_group_prefer_the_entry_then_the_identity_then_dash():
    identity = Identity(user="alice", profile="admin")
    assert owner_name(501, identity) == "501"
    assert owner_name(None, identity) == "alice"
    assert owner_name(None, Identity(profile="admin")) == "-"
    assert owner_name(None, None) == "-"
    assert group_name("staff", identity) == "staff"
    assert group_name(None, identity) == "admin"
    assert group_name(None, Identity(user="alice")) == "-"
    assert group_name(None, NO_IDENTITY) == "-"


def test_identity_reads_the_name_plane_and_the_session_plane():
    session = Session(session_id="s", profile="admin")
    view = session_view(session)
    ns = NamespaceView(user="alice")
    assert identity_from(ns, view) == Identity(user="alice", profile="admin")
    assert identity_from(None, None) == NO_IDENTITY
    assert identity_of(CommandOpts(ns=ns, session_view=view)) == Identity(
        user="alice", profile="admin")
    assert identity_of(CommandOpts()) == NO_IDENTITY


async def _run(ws: Workspace, line: str) -> tuple[int, str]:
    io = await ws.execute(line)
    out = await materialize(io.stdout) if io.stdout else b""
    return io.exit_code, out.decode()


def _ws(**kwargs) -> Workspace:
    resource = RAMResource()
    resource._store.files["/f.txt"] = b"hello"
    return Workspace({"/data/": (resource, MountMode.WRITE)},
                     mode=MountMode.WRITE,
                     **kwargs)


@pytest.mark.asyncio
async def test_ls_stat_and_find_render_user_and_profile():
    ws = _ws(agent_id="alice",
             profiles={"admin": SessionProfile()},
             profile="admin")
    _, ls_out = await _run(ws, "ls -l /data/f.txt")
    assert ls_out == "-rw-r--r-- 1 alice admin 5 Jan  1 00:00 /data/f.txt\n"
    _, stat_out = await _run(ws, 'stat -c "%U %G" /data/f.txt')
    assert stat_out == "alice admin\n"
    _, find_out = await _run(ws, "find /data -type f -printf '%u %g %p\\n'")
    assert find_out == "alice admin /data/f.txt\n"
    _, who = await _run(ws, "whoami")
    assert who == "alice\n"


@pytest.mark.asyncio
async def test_missing_user_or_profile_renders_as_dash():
    ws = _ws()
    _, ls_out = await _run(ws, "ls -l /data/f.txt")
    assert ls_out == "-rw-r--r-- 1 - - 5 Jan  1 00:00 /data/f.txt\n"
    _, stat_out = await _run(ws, 'stat -c "%U %G" /data/f.txt')
    assert stat_out == "- -\n"


@pytest.mark.asyncio
async def test_a_named_session_reports_its_own_profile():
    ws = _ws(agent_id="alice",
             profiles={
                 "default": SessionProfile(),
                 "reviewer": SessionProfile()
             })
    _, own = await _run(ws, 'stat -c "%G" /data/f.txt')
    assert own == "default\n"
    ws.create_session("r1", profile="reviewer")
    io = await ws.execute('stat -c "%G" /data/f.txt', session_id="r1")
    assert (await materialize(io.stdout)).decode() == "reviewer\n"
