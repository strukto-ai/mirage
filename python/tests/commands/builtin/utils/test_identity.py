import pytest

from mirage.commands.builtin.utils.identity import (
    NOBODY,
    ROOT,
    Account,
    Identity,
    find_user,
    group_id,
    group_id_named,
    group_label,
    group_with_id,
    home_of,
    identity_from,
    identity_of,
    own_account,
    owner_id,
    owner_label,
    owner_name,
    session_uid,
    user_homes,
    user_named,
)
from mirage.commands.config import Context
from mirage.io.types import materialize
from mirage.policy.profile import SessionProfile
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.session.session import SessionState
from mirage.workspace.session.state import session_view


def test_no_profile_is_root_a_named_one_uid_1000_a_nameless_one_unnamed():
    assert own_account(Identity()) == ROOT
    assert own_account(None) == ROOT
    assert own_account(Identity(profile="root")) == ROOT
    assert own_account(Identity(profile="nobody")) == NOBODY
    assert own_account(Identity(profile="admin")) == Account(
        "admin", 1000, "admin", 1000, "/home/admin"
    )
    assert own_account(Identity(profile="")) is None
    assert session_uid(Identity(profile="")) == 1000
    assert home_of(Identity(profile="")) == "/"
    assert home_of(Identity()) == "/root"


def test_owner_and_group_prefer_the_entry_then_the_session():
    identity = Identity(profile="admin")
    assert owner_label(501, identity) == "501"
    assert owner_label(None, identity) == "admin"
    assert owner_label(1000, identity) == "admin"
    assert owner_label("0", identity) == "root"
    assert owner_label(None, Identity()) == "root"
    assert owner_label(None, Identity(profile="")) == "1000"
    assert owner_name(None, Identity(profile="")) is None
    assert owner_label("user", identity) == "user"
    assert owner_id("nobody", identity) == 65534
    assert owner_id("user", identity) == "user"
    assert group_label(65534, identity) == "nogroup"
    assert group_label(None, identity) == "admin"
    assert group_id(None, Identity()) == 0


def test_lookups_read_root_nobody_and_the_session_user():
    identity = Identity(profile="admin")
    assert find_user(identity, "admin") == own_account(identity)
    assert find_user(identity, "0") == ROOT
    assert find_user(identity, "1000") == own_account(identity)
    assert find_user(Identity(), "1000") is None
    assert find_user(identity, "zz") is None
    assert find_user(identity, "+0") == ROOT
    assert find_user(Identity(profile="+42"), "+42") is None
    assert find_user(identity, "\u00b2") is None
    assert user_named(identity, "0") is None
    assert user_named(identity, "nobody") == NOBODY
    assert group_id_named(identity, "nogroup") == 65534
    assert group_with_id(identity, 4242) is None
    assert user_homes(identity) == {
        "root": "/root",
        "nobody": "/nonexistent",
        "admin": "/home/admin",
    }


def test_identity_reads_the_session_plane():
    session = SessionState(session_id="s", profile="admin")
    view = session_view(session)
    assert identity_from(view) == Identity(profile="admin")
    assert identity_from(None) == Identity()
    assert identity_of(Context(session=view)) == Identity(profile="admin")
    assert identity_of(Context()) == Identity()


async def _run(ws: Workspace, line: str) -> tuple[int, str]:
    io = await ws.shell(line)
    out = await materialize(io.stdout) if io.stdout else b""
    return io.exit_code, out.decode()


def _ws(**kwargs) -> Workspace:
    vfs = RAMVFS()
    vfs._store.files["/f.txt"] = b"hello"
    return Workspace(
        {"/data/": (vfs, MountMode.WRITE)}, mode=MountMode.WRITE, **kwargs
    )


@pytest.mark.asyncio
async def test_ls_stat_find_and_whoami_render_the_profile():
    ws = _ws(profiles={"admin": SessionProfile()}, profile="admin")
    _, ls_out = await _run(ws, "ls -l /data/f.txt")
    assert ls_out == "-rw-r--r-- 1 admin admin 5 - /data/f.txt\n"
    _, stat_out = await _run(ws, 'stat -c "%U %G" /data/f.txt')
    assert stat_out == "admin admin\n"
    _, find_out = await _run(ws, "find /data -type f -printf '%u %g %p\\n'")
    assert find_out == "admin admin /data/f.txt\n"
    _, who = await _run(ws, "whoami")
    assert who == "admin\n"


@pytest.mark.asyncio
async def test_a_session_with_no_profile_renders_as_root():
    ws = _ws()
    _, ls_out = await _run(ws, "ls -l /data/f.txt")
    assert ls_out == "-rw-r--r-- 1 root root 5 - /data/f.txt\n"
    _, stat_out = await _run(ws, 'stat -c "%U %u %G %g" /data/f.txt')
    assert stat_out == "root 0 root 0\n"


@pytest.mark.asyncio
async def test_a_named_session_reports_its_own_profile():
    ws = _ws(
        profiles={"default": SessionProfile(), "reviewer": SessionProfile()},
    )
    _, own = await _run(ws, 'stat -c "%G" /data/f.txt')
    assert own == "default\n"
    ws.create_session("r1", profile="reviewer")
    io = await ws.shell('stat -c "%G" /data/f.txt', session_id="r1")
    assert (await materialize(io.stdout)).decode() == "reviewer\n"


@pytest.mark.asyncio
async def test_a_name_the_database_lacks_prints_as_unknown_in_id_fields():
    ws = _ws()
    await ws.vfs.setattr("/data/f.txt", uid="alice", gid="staff")
    _, stat_out = await _run(ws, "stat -c '%u %g %U %G' /data/f.txt")
    assert stat_out == "? ? alice staff\n"
    _, ls_out = await _run(ws, "ls -n /data/f.txt; ls -l /data/f.txt")
    assert ls_out == (
        "-rw-r--r-- 1 ? ? 5 - /data/f.txt\n"
        "-rw-r--r-- 1 alice staff 5 - /data/f.txt\n"
    )
    await ws.vfs.symlink("/data/l", "f.txt")
    await ws.vfs.setattr("/data/l", uid="bob", gid="ops", nofollow=True)
    _, link_out = await _run(ws, "stat -c '%u %g %U %G' /data/l")
    assert link_out == "? ? bob ops\n"


@pytest.mark.asyncio
async def test_a_field_past_the_memory_budget_is_refused():
    ws = _ws(max_memory="1MB")
    io = await ws.shell("stat -c '%.9999999u' /data/f.txt")
    err = await materialize(io.stderr) if io.stderr else b""
    assert (io.exit_code, err) == (1, b"stat: memory exhausted\n")
    uncapped = _ws(max_memory=None)
    io = await uncapped.shell("stat -c '%.536870889u' /data/f.txt")
    err = await materialize(io.stderr) if io.stderr else b""
    assert (io.exit_code, err) == (1, b"stat: memory exhausted\n")


@pytest.mark.asyncio
async def test_a_precision_cuts_a_multibyte_name_by_bytes():
    ws = _ws(profiles={"équipe": SessionProfile()}, profile="équipe")
    io = await ws.shell("stat -c '[%.2U] [%.3G] [%.1U] [%.1G]' /data/f.txt")
    assert (
        await materialize(io.stdout)
        == b"[\xc3\xa9] [\xc3\xa9q] [\xc3] [\xc3]\n"
    )


@pytest.mark.asyncio
async def test_a_profile_name_past_utf8_keeps_its_bytes_for_the_home():
    name = "team\udcff"
    ws = _ws(profiles={name: SessionProfile()}, profile=name)
    io = await ws.shell(f"echo ~; echo ~{name}")
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"/home/team\xff\n/home/team\xff\n"
