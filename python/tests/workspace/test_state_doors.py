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

import asyncio

import pytest

from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import CommandSpec
from mirage.fuse.core import MountCore
from mirage.io.types import IOResult
from mirage.policy import Action, Deny, OpsContext, Policy
from mirage.policy.types import SessionContext
from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace
from mirage.workspace.session import reset_current_session, set_current_session


class DenyOp(Policy):
    """Refuse one op name outright, whatever path asked."""

    def __init__(self, op: str) -> None:
        self._op = op

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        if ctx.op == self._op:
            return Deny(f"{self._op} refused by policy\n")
        return None


class _OverlayRAMResource(RAMResource):
    """RAM resource with the native setattr op stripped, standing in for
    an API backend that has no attribute slot."""

    def __init__(self) -> None:
        super().__init__()
        self._ops_list = [ro for ro in self._ops_list if ro.name != "setattr"]


def _two_mounts(policies=None) -> Workspace:
    a = RAMResource()
    a._store.files["/x.txt"] = b"public\n"
    b = RAMResource()
    b._store.files["/y.txt"] = b"other\n"
    return Workspace({
        "/a": (a, MountMode.WRITE),
        "/b": (b, MountMode.WRITE)
    },
                     mode=MountMode.WRITE,
                     policies=policies)


def test_fuse_symlink_on_ungranted_turf_is_refused():
    # The R8 hole: a session-scoped kernel mount could create a link on
    # an ungranted mount's turf because the FUSE symlink path wrote the
    # namespace table directly, at a layer no session grant covers.
    ws = _two_mounts()
    sess = ws.create_session("agent", mounts={"/a": "write"})
    core = MountCore(ws.ops, session=sess)
    with pytest.raises(PermissionError):
        core.symlink("/b/lk", "/a/x.txt")
    assert not ws.namespace.is_link("/b/lk")


def test_fuse_symlink_on_granted_turf_still_works():
    ws = _two_mounts()
    sess = ws.create_session("agent", mounts={"/a": "write"})
    core = MountCore(ws.ops, session=sess)
    core.symlink("/a/lk", "x.txt")
    assert ws.namespace.readlink("/a/lk") == "x.txt"


def test_ln_fires_the_op_gates():
    ws = _two_mounts(policies=[DenyOp("symlink")])

    async def run():
        return await ws.execute("ln -s x.txt /a/lk")

    io = asyncio.run(run())
    assert io.exit_code != 0
    assert b"Permission denied" in (io.stderr or b"")
    assert not ws.namespace.is_link("/a/lk")


def test_ln_leaves_an_op_record():
    # The op ledger must not say a workspace with ln traffic did
    # nothing: the door records the namespace write like any other op.
    ws = _two_mounts()

    async def run():
        return await ws.execute("ln -s x.txt /a/lk")

    io = asyncio.run(run())
    assert io.exit_code == 0
    assert any(r.op == "symlink" and r.path == "/a/lk" for r in ws.ops.records)


def test_scoped_shell_ln_onto_ungranted_turf_is_refused():
    ws = _two_mounts()
    ws.create_session("agent", mounts={"/a": "write"})

    async def run():
        return await ws.execute("ln -s /a/x.txt /b/lk", session_id="agent")

    io = asyncio.run(run())
    assert io.exit_code != 0
    assert not ws.namespace.is_link("/b/lk")


def test_symlink_and_readlink_answer_on_the_ops_facade():
    # readlink is the read twin: guests and CLIs ask through the same
    # door instead of a bespoke channel.
    ws = _two_mounts()

    async def run():
        await ws.ops.symlink("/a/lk", "x.txt")
        return await ws.ops.readlink("/a/lk")

    assert asyncio.run(run()) == "x.txt"
    assert ws.namespace.readlink("/a/lk") == "x.txt"


def test_scoped_shell_readlink_on_ungranted_turf_is_refused():
    # The read twin of the scoped-ln hole: a session granted only /a
    # must not learn /b/lk's target through the readlink builtin, which
    # used to read the node table directly instead of dispatching.
    ws = _two_mounts()
    ws.create_session("agent", mounts={"/a": "write"})

    async def run():
        made = await ws.execute("ln -s /b/y.txt /b/lk")
        assert made.exit_code == 0
        return await ws.execute("readlink /b/lk", session_id="agent")

    io = asyncio.run(run())
    assert io.exit_code != 0
    assert b"y.txt" not in (io.stdout or b"")


def test_scoped_shell_readlink_f_on_ungranted_turf_is_refused():
    # -m/-f canonicalize without any existence probe, so without the
    # gate they printed the resolved target of an ungranted link.
    ws = _two_mounts()
    ws.create_session("agent", mounts={"/a": "write"})

    async def run():
        made = await ws.execute("ln -s /b/y.txt /b/lk")
        assert made.exit_code == 0
        return await ws.execute("readlink -m /b/lk", session_id="agent")

    io = asyncio.run(run())
    assert io.exit_code != 0
    assert b"y.txt" not in (io.stdout or b"")


def test_shell_readlink_fires_the_op_gates():
    ws = _two_mounts(policies=[DenyOp("readlink")])

    async def run():
        made = await ws.execute("ln -s x.txt /a/lk")
        assert made.exit_code == 0
        return await ws.execute("readlink /a/lk")

    io = asyncio.run(run())
    assert io.exit_code != 0
    assert b"x.txt" not in (io.stdout or b"")


def test_readlink_on_a_non_link_raises_einval():
    ws = _two_mounts()

    async def run():
        return await ws.ops.readlink("/a/x.txt")

    with pytest.raises(OSError):
        asyncio.run(run())


def test_chown_h_on_a_link_fires_the_op_gates():
    # chown -h writes the link's own attrs; that overlay write used to
    # bypass the door entirely, so no policy could bound it.
    ws = _two_mounts(policies=[DenyOp("setattr")])

    async def run():
        made = await ws.execute("ln -s x.txt /a/lk")
        assert made.exit_code == 0
        return await ws.execute("chown -h alice /a/lk")

    io = asyncio.run(run())
    assert io.exit_code != 0
    assert b"Permission denied" in (io.stderr or b"")
    meta = ws.namespace.meta_for("/a/lk")
    assert meta is None or meta.uid is None


def test_overlay_setattr_fires_the_op_gates():
    # A backend with no native setattr op stores attrs in the namespace
    # overlay; that write must clear the same gates as a native one.
    o = _OverlayRAMResource()
    o._store.files["/f.txt"] = b"body\n"
    ws = Workspace({"/o": (o, MountMode.WRITE)},
                   mode=MountMode.WRITE,
                   policies=[DenyOp("setattr")])

    async def run():
        return await ws.execute("chmod 600 /o/f.txt")

    io = asyncio.run(run())
    assert io.exit_code != 0
    assert b"Permission denied" in (io.stderr or b"")
    meta = ws.namespace.meta_for("/o/f.txt")
    assert meta is None or meta.mode is None


def test_overlay_setattr_still_lands_without_policies():
    o = _OverlayRAMResource()
    o._store.files["/f.txt"] = b"body\n"
    ws = Workspace({"/o": (o, MountMode.WRITE)}, mode=MountMode.WRITE)

    async def run():
        return await ws.execute("chmod 600 /o/f.txt")

    io = asyncio.run(run())
    assert io.exit_code == 0, f"unexpected refusal: {io}"
    meta = ws.namespace.meta_for("/o/f.txt")
    assert meta is not None and meta.mode == 0o600


class DenySecretEnv(Policy):
    """Veto env writes to SECRET_* names through the session view."""

    async def pre_session(self, ctx: SessionContext) -> Action | None:
        if ctx.plane == "env" and ctx.key.startswith("SECRET"):
            return Deny("SECRET_* refused by policy\n")
        return None


def test_export_fires_the_state_gate():
    # The session plane's gate: an env write clears pre_session exactly
    # as a VFS write clears pre_ops, whichever tier asked.
    ws = _two_mounts(policies=[DenySecretEnv()])

    async def run():
        denied = await ws.execute("export SECRET_X=1")
        allowed = await ws.execute("export PUBLIC_X=1")
        return denied, allowed

    denied, allowed = asyncio.run(run())
    assert denied.exit_code != 0
    assert b"refused by policy" in (denied.stderr or b"")
    assert "SECRET_X" not in ws.env
    assert allowed.exit_code == 0
    assert ws.env.get("PUBLIC_X") == "1"


def test_command_env_is_a_snapshot_not_the_live_dict():
    # A command's env is the process view: a child cannot write the
    # parent's environment, so a mutation must not land in the session.

    @command("envpoke", resource="ram", spec=CommandSpec())
    async def envpoke(store, paths: list[PathSpec], texts: list[str],
                      opts: CommandOpts):
        assert opts.env is not None
        opts.env["INJECTED"] = "1"
        return b"", IOResult()

    ws = _two_mounts()
    mount = ws._registry.mount_for("/a/")
    for rc in envpoke._registered_commands:
        mount.register(rc)

    async def run():
        return await ws.execute("envpoke /a/x.txt")

    io = asyncio.run(run())
    assert io.exit_code == 0
    assert "INJECTED" not in ws.env


def test_a_command_can_opt_into_the_session_view():
    # The LinkView pattern for the session plane: the live handle rides
    # CommandOpts, and reads answer through the view.

    @command("envread", resource="ram", spec=CommandSpec())
    async def envread(store, paths: list[PathSpec], texts: list[str],
                      opts: CommandOpts):
        assert opts.session_view is not None
        value = opts.session_view.get("MARKER") or "none"
        return value.encode(), IOResult()

    ws = _two_mounts()
    mount = ws._registry.mount_for("/a/")
    for rc in envread._registered_commands:
        mount.register(rc)

    async def run():
        await ws.execute("export MARKER=yes")
        result = await ws.execute("envread /a/x.txt")
        return await result.stdout_str()

    assert asyncio.run(run()).strip() == "yes"


def test_facade_symlink_respects_session_grants():
    ws = _two_mounts()
    sess = ws.create_session("agent", mounts={"/a": "write"})

    async def run():
        token = set_current_session(sess)
        try:
            await ws.ops.symlink("/a/lk", "x.txt")
            with pytest.raises(PermissionError, match="not allowed"):
                await ws.ops.symlink("/b/lk", "y.txt")
        finally:
            reset_current_session(token)

    asyncio.run(run())
    assert ws.namespace.is_link("/a/lk")
    assert not ws.namespace.is_link("/b/lk")


def test_bare_export_of_a_new_name_fires_the_gate():
    # `export NAME` with no value writes an empty entry, which is still
    # a session write; an existing name is re-marked, not rewritten.
    ws = _two_mounts(policies=[DenySecretEnv()])

    async def run():
        denied = await ws.execute("export SECRET_BARE")
        allowed = await ws.execute("export PUBLIC_BARE")
        return denied, allowed

    denied, allowed = asyncio.run(run())
    assert denied.exit_code != 0
    assert b"refused by policy" in (denied.stderr or b"")
    assert "SECRET_BARE" not in ws.env
    assert allowed.exit_code == 0
    assert ws.env.get("PUBLIC_BARE") == ""


def test_local_fires_the_gate():
    ws = _two_mounts(policies=[DenySecretEnv()])

    async def run():
        return await ws.execute("f() { local SECRET_L=1; }; f")

    io = asyncio.run(run())
    assert io.exit_code != 0
    assert b"refused by policy" in (io.stderr or b"")
    assert "SECRET_L" not in ws.env


def test_plain_assignment_fires_the_gate():
    # The assignment path used to write `session.env` directly, so a
    # policy that vetoed `export SECRET_X=1` still admitted
    # `SECRET_X=1`. Denial mirrors the readonly case: a fatal
    # variable-assignment error that abandons the rest of the line.
    ws = _two_mounts(policies=[DenySecretEnv()])

    async def run():
        denied = await ws.execute("SECRET_P=1; echo after")
        allowed = await ws.execute("PUBLIC_P=1")
        return denied, allowed

    denied, allowed = asyncio.run(run())
    assert denied.exit_code != 0
    assert b"refused by policy" in (denied.stderr or b"")
    assert "SECRET_P" not in ws.env
    assert allowed.exit_code == 0
    assert ws.env.get("PUBLIC_P") == "1"


def test_append_assignment_fires_the_gate():
    ws = _two_mounts(policies=[DenySecretEnv()])

    async def run():
        return await ws.execute("SECRET_A+=x")

    io = asyncio.run(run())
    assert io.exit_code != 0
    assert "SECRET_A" not in ws.env


def test_array_assignment_fires_the_gate():
    # A denied name must not be writable by switching to array syntax:
    # SECRET=(a b) lands on the same session plane as SECRET=x.
    ws = _two_mounts(policies=[DenySecretEnv()])

    async def run():
        return await ws.execute("SECRET_V=(a b); echo after")

    io = asyncio.run(run())
    assert io.exit_code != 0
    assert b"refused by policy" in (io.stderr or b"")
    sess = ws._session_mgr.get(ws._session_mgr.default_id)
    assert "SECRET_V" not in sess.arrays


def test_array_append_assignment_fires_the_gate():
    ws = _two_mounts(policies=[DenySecretEnv()])

    async def run():
        return await ws.execute("SECRET_VA+=(a)")

    io = asyncio.run(run())
    assert io.exit_code != 0
    sess = ws._session_mgr.get(ws._session_mgr.default_id)
    assert "SECRET_VA" not in sess.arrays


def test_subscript_assignment_fires_the_gate():
    ws = _two_mounts(policies=[DenySecretEnv()])

    async def run():
        return await ws.execute("SECRET_S[0]=x")

    io = asyncio.run(run())
    assert io.exit_code != 0
    sess = ws._session_mgr.get(ws._session_mgr.default_id)
    assert "SECRET_S" not in sess.arrays
    assert "SECRET_S" not in ws.env


def test_scalar_append_onto_an_existing_array_fires_the_gate():
    # SECRET+=x on a name that already holds an array appends to
    # element 0 through a branch of its own; it is still a session
    # write.
    ws = _two_mounts(policies=[DenySecretEnv()])
    sess = ws._session_mgr.get(ws._session_mgr.default_id)
    sess.arrays["SECRET_E"] = ["a"]

    async def run():
        return await ws.execute("SECRET_E+=x")

    io = asyncio.run(run())
    assert io.exit_code != 0
    assert sess.arrays["SECRET_E"] == ["a"]


def test_declaration_array_assignment_fires_the_gate():
    # export/declare with an array literal store through the staged
    # path, not handle_export, so the gate has to fire there too.
    ws = _two_mounts(policies=[DenySecretEnv()])

    async def run():
        return await ws.execute("export SECRET_D=(a)")

    io = asyncio.run(run())
    assert io.exit_code != 0
    assert b"refused by policy" in (io.stderr or b"")
    sess = ws._session_mgr.get(ws._session_mgr.default_id)
    assert "SECRET_D" not in sess.arrays


def test_readonly_name_refuses_a_declaration_array_store():
    # The staged-array store is the builtin's own; the shell's readonly
    # rule is pre-checked there, before the door is asked.
    ws = _two_mounts()

    async def run():
        await ws.execute("readonly LOCKED")
        return await ws.execute("export LOCKED=(a)")

    io = asyncio.run(run())
    assert io.exit_code != 0
    assert b"readonly variable" in (io.stderr or b"")
    sess = ws._session_mgr.get(ws._session_mgr.default_id)
    assert "LOCKED" not in sess.arrays


def test_readonly_declaration_array_abandons_the_line():
    # GNU treats `export LOCKED=(a)` on a readonly name as a variable
    # assignment error, not a builtin failure: the rest of the line is
    # dead (status 1) and the next line runs. Pinned on bash 5.2
    # (debian:stable-slim); the scalar spelling below continues instead.
    ws = _two_mounts()

    async def run():
        await ws.execute("readonly LOCKED")
        denied = await ws.execute("export LOCKED=(a); echo unreached")
        out = await denied.stdout_str() if denied.stdout else ""
        after = await ws.execute("echo after")
        return denied, out, after

    denied, out, after = asyncio.run(run())
    assert denied.exit_code == 1
    assert out == ""
    assert (denied.stderr or b"") == b"bash: LOCKED: readonly variable\n"
    assert after.exit_code == 0


def test_readonly_declare_array_is_fatal_at_top_level():
    ws = _two_mounts()

    async def run():
        await ws.execute("readonly LOCKED")
        denied = await ws.execute("declare LOCKED=(a); echo unreached")
        out = await denied.stdout_str() if denied.stdout else ""
        return denied, out

    denied, out = asyncio.run(run())
    assert denied.exit_code == 1
    assert out == ""


def test_readonly_scalar_export_refusal_continues_the_line():
    # The asymmetry is GNU's: `export LOCKED=v` fails with 1 in the
    # builtin's voice and the same line keeps going.
    ws = _two_mounts()

    async def run():
        await ws.execute("readonly LOCKED")
        io = await ws.execute("export LOCKED=v; echo rc=$?")
        out = await io.stdout_str() if io.stdout else ""
        return io, out

    io, out = asyncio.run(run())
    assert io.exit_code == 0
    assert out == "rc=1\n"


def test_readonly_local_array_refusal_stays_in_the_function():
    # `local LOCKED=(a)` on a readonly global refuses without killing
    # the function body (GNU prints the refusal and runs `echo in-f`).
    ws = _two_mounts()

    async def run():
        await ws.execute("readonly LOCKED")
        io = await ws.execute("f() { local LOCKED=(a); echo in-f; }; f")
        out = await io.stdout_str() if io.stdout else ""
        return io, out

    io, out = asyncio.run(run())
    assert "in-f" in out
    assert b"readonly variable" in (io.stderr or b"")


def test_export_of_an_array_literal_prints_nothing():
    # `export ARR=(x y)` used to fall through to the bare-export print
    # branch because the handler never learned arrays were on the line.
    ws = _two_mounts()

    async def run():
        io = await ws.execute("export ARR=(x y)")
        out = await io.stdout_str() if io.stdout else ""
        return io, out

    io, out = asyncio.run(run())
    assert io.exit_code == 0
    assert out == ""
    sess = ws._session_mgr.get(ws._session_mgr.default_id)
    assert sess.arrays.get("ARR") == ["x", "y"]


def test_readonly_loop_variable_refuses_before_the_body():
    # bash refuses a readonly loop variable and never runs the body;
    # the loop writes go through the view now, same as any assignment.
    ws = _two_mounts()

    async def run():
        await ws.execute("readonly LV")
        denied = await ws.execute("for LV in a b; do echo ran; done")
        out = await denied.stdout_str() if denied.stdout else ""
        return denied, out

    denied, out = asyncio.run(run())
    assert denied.exit_code != 0
    assert "ran" not in out


def test_the_gate_learns_which_session_asked():
    # `deny set for session X` is just a policy once the context says
    # who asked; the door adds the id in one place for every spelling.
    seen: list[str] = []

    class CaptureSession(Policy):

        async def pre_session(self, ctx: SessionContext) -> Action | None:
            seen.append(ctx.session_id)
            return None

    ws = _two_mounts(policies=[CaptureSession()])
    ws.create_session("agent", mounts={"/a": "write"})

    async def run():
        await ws.execute("X=1", session_id="agent")

    asyncio.run(run())
    assert seen == ["agent"]


def test_subscripted_unset_of_a_scalar_fires_the_gate():
    # `unset 'SECRET[0]'` on a scalar is the whole unset in element
    # clothing; the element branch used to skip the view entirely.
    ws = _two_mounts(policies=[DenySecretEnv()])
    ws.env["SECRET_U"] = "v"

    async def run():
        return await ws.execute("unset 'SECRET_U[0]'")

    io = asyncio.run(run())
    assert io.exit_code != 0
    assert b"refused by policy" in (io.stderr or b"")
    assert ws.env.get("SECRET_U") == "v"


def test_subscripted_unset_of_an_array_element_fires_the_gate():
    ws = _two_mounts(policies=[DenySecretEnv()])
    sess = ws._session_mgr.get(ws._session_mgr.default_id)
    sess.arrays["SECRET_W"] = ["a", "b"]

    async def run():
        return await ws.execute("unset 'SECRET_W[1]'")

    io = asyncio.run(run())
    assert io.exit_code != 0
    assert sess.arrays["SECRET_W"] == ["a", "b"]


def test_for_loop_variable_fires_the_gate():
    # The loop variable is a session write per iteration; a denied
    # write aborts the loop before its body runs, like a readonly
    # loop variable in bash.
    ws = _two_mounts(policies=[DenySecretEnv()])

    async def run():
        denied = await ws.execute("for SECRET_I in a b; do echo ran; done")
        out = await denied.stdout_str() if denied.stdout else ""
        allowed = await ws.execute("for PUB_I in a b; do echo ok; done")
        allowed_out = await allowed.stdout_str()
        return denied, out, allowed, allowed_out

    denied, out, allowed, allowed_out = asyncio.run(run())
    assert denied.exit_code != 0
    assert "ran" not in out
    assert "SECRET_I" not in ws.env
    assert allowed.exit_code == 0
    assert allowed_out.count("ok") == 2
