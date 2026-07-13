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

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.session import reset_current_session, set_current_session


def _seed(name: str, body: bytes) -> RAMResource:
    r = RAMResource()
    r._store.files[f"/{name}"] = body
    return r


def test_session_outside_allowlist_is_denied():
    a = _seed("x.txt", b"public")
    b = _seed("secret.txt", b"SECRET")
    ws = Workspace({"/a": a, "/b": b})
    ws.create_session("agent", mounts=["/a"])

    async def run():
        ok = await ws.execute("cat /a/x.txt", session_id="agent")
        denied = await ws.execute("cat /b/secret.txt", session_id="agent")
        return ok, denied

    ok, denied = asyncio.run(run())
    assert ok.exit_code == 0
    assert b"public" in (ok.stdout or b"")
    assert denied.exit_code != 0
    stderr = denied.stderr or b""
    assert b"not allowed" in stderr
    assert b"/b" in stderr


def test_default_session_unrestricted():
    a = _seed("x.txt", b"hi")
    ws = Workspace({"/a": a})

    async def run():
        return await ws.execute("cat /a/x.txt")

    io = asyncio.run(run())
    assert io.exit_code == 0
    assert b"hi" in (io.stdout or b"")


def test_allowed_session_can_write_to_its_mount():
    a = _seed("x.txt", b"hi")
    ws = Workspace({"/a": (a, MountMode.WRITE)}, mode=MountMode.WRITE)
    ws.create_session("agent", mounts=["/a"])

    async def run():
        return await ws.execute("echo new > /a/y.txt", session_id="agent")

    io = asyncio.run(run())
    assert io.exit_code == 0, f"unexpected denial: {io}"
    assert a._store.files.get("/y.txt") == b"new\n"


def test_history_view_always_allowed():
    a = _seed("x.txt", b"hi")
    ws = Workspace({"/a": a})
    ws.create_session("agent", mounts=["/a"])

    async def run():
        await ws.execute("ls /a", session_id="agent")
        return await ws.execute("history", session_id="agent")

    io = asyncio.run(run())
    assert io.exit_code == 0, (
        f"history view should always be reachable, got {io}")


def test_ops_blocks_programmatic_read_outside_allowlist():
    a = _seed("x.txt", b"public")
    b = _seed("secret.txt", b"SECRET")
    ws = Workspace({"/a": a, "/b": b})
    sess = ws.create_session("agent", mounts=["/a"])

    async def run():
        token = set_current_session(sess)
        try:
            assert await ws.ops.read("/a/x.txt") == b"public"
            with pytest.raises(PermissionError, match="not allowed"):
                await ws.ops.read("/b/secret.txt")
        finally:
            reset_current_session(token)

    asyncio.run(run())


def _two_mounts_with_secret() -> Workspace:
    a = _seed("x.txt", b"public-A\n")
    a._store.files["/y.txt"] = b"public-B\n"
    b = _seed("secret.txt", b"SECRET-FROM-B\n")
    ws = Workspace({
        "/a": (a, MountMode.WRITE),
        "/b": (b, MountMode.WRITE)
    },
                   mode=MountMode.WRITE)
    ws.create_session("agent", mounts=["/a"])
    return ws


def test_pipe_across_mounts_blocks_forbidden_read():
    ws = _two_mounts_with_secret()

    async def run():
        return await ws.execute("cat /b/secret.txt | wc -l",
                                session_id="agent")

    io = asyncio.run(run())
    # Bash convention: a downstream success masks an upstream failure
    # (no `pipefail`). Security guarantee: no leak + audit on stderr.
    assert b"SECRET" not in (io.stdout or b""), (
        f"forbidden read must not reach the pipe, got stdout={io.stdout!r}")
    assert b"not allowed" in (io.stderr or b"")
    assert b"/b" in (io.stderr or b"")


def test_pipe_within_allowed_mount_succeeds():
    ws = _two_mounts_with_secret()

    async def run():
        return await ws.execute("cat /a/x.txt | wc -c", session_id="agent")

    io = asyncio.run(run())
    assert io.exit_code == 0, f"in-allowlist pipe must succeed, got {io}"


def test_command_substitution_into_forbidden_mount_is_denied():
    ws = _two_mounts_with_secret()

    async def run():
        return await ws.execute("echo $(cat /b/secret.txt)",
                                session_id="agent")

    io = asyncio.run(run())
    assert io.exit_code != 0 or b"SECRET" not in (io.stdout or b""), (
        f"command substitution must not leak forbidden read, got {io}")


def test_subshell_inherits_session_capability():
    ws = _two_mounts_with_secret()

    async def run():
        return await ws.execute("(cat /b/secret.txt)", session_id="agent")

    io = asyncio.run(run())
    assert io.exit_code != 0
    assert b"not allowed" in (io.stderr or b"")


def test_and_chain_short_circuits_on_denial():
    ws = _two_mounts_with_secret()

    async def run():
        return await ws.execute("cat /b/secret.txt && cat /a/x.txt",
                                session_id="agent")

    io = asyncio.run(run())
    assert io.exit_code != 0
    assert b"public-A" not in (io.stdout or b""), (
        "denied left side should short-circuit the && chain")


def test_or_chain_falls_through_to_allowed():
    ws = _two_mounts_with_secret()

    async def run():
        return await ws.execute("cat /b/secret.txt || cat /a/x.txt",
                                session_id="agent")

    io = asyncio.run(run())
    assert b"public-A" in (io.stdout or b""), (
        f"|| should fall through to the allowed branch, got {io}")


def test_redirect_to_forbidden_mount_is_denied():
    ws = _two_mounts_with_secret()

    async def run():
        return await ws.execute("echo leaked > /b/leaked.txt",
                                session_id="agent")

    io = asyncio.run(run())
    assert io.exit_code != 0
    assert b"not allowed" in (io.stderr or b"")


def test_cross_mount_copy_into_forbidden_mount_is_denied():
    ws = _two_mounts_with_secret()

    async def run():
        return await ws.execute("cp /a/x.txt /b/leaked.txt",
                                session_id="agent")

    io = asyncio.run(run())
    assert io.exit_code != 0
    assert b"not allowed" in (io.stderr or b"")


def test_concurrent_sessions_isolated():
    a = _seed("x.txt", b"A-only\n")
    b = _seed("y.txt", b"B-only\n")
    ws = Workspace({"/a": a, "/b": b})
    ws.create_session("agent_a", mounts=["/a"])
    ws.create_session("agent_b", mounts=["/b"])

    async def run():
        results = await asyncio.gather(
            ws.execute("cat /a/x.txt", session_id="agent_a"),
            ws.execute("cat /b/y.txt", session_id="agent_b"),
            ws.execute("cat /b/y.txt", session_id="agent_a"),
            ws.execute("cat /a/x.txt", session_id="agent_b"),
        )
        return results

    a_ok, b_ok, a_denied, b_denied = asyncio.run(run())
    assert a_ok.exit_code == 0 and b"A-only" in (a_ok.stdout or b"")
    assert b_ok.exit_code == 0 and b"B-only" in (b_ok.stdout or b"")
    assert a_denied.exit_code != 0
    assert b_denied.exit_code != 0


def test_background_job_inherits_capability():
    ws = _two_mounts_with_secret()

    async def run():
        # Background a forbidden read; the job runs in a Task that
        # snapshots the contextvar. wait reaps it; jobs reports state.
        return await ws.execute(
            "cat /b/secret.txt &; wait",
            session_id="agent",
        )

    io = asyncio.run(run())
    out = (io.stdout or b"") + (io.stderr or b"")
    assert b"SECRET" not in out, (
        f"background job must not leak forbidden read, got {io}")


def test_read_grant_blocks_command_write():
    a = _seed("x.txt", b"hi")
    ws = Workspace({"/a": (a, MountMode.WRITE)}, mode=MountMode.WRITE)
    ws.create_session("agent", mounts={"/a": "read"})

    async def run():
        ok = await ws.execute("cat /a/x.txt", session_id="agent")
        denied = await ws.execute("rm /a/x.txt", session_id="agent")
        return ok, denied

    ok, denied = asyncio.run(run())
    assert ok.exit_code == 0 and b"hi" in (ok.stdout or b"")
    assert denied.exit_code != 0
    assert b"read-only mount at /a/" in (denied.stderr or b"")
    assert a._store.files.get("/x.txt") == b"hi"


def test_read_grant_blocks_redirect_write():
    a = _seed("x.txt", b"hi")
    ws = Workspace({"/a": (a, MountMode.WRITE)}, mode=MountMode.WRITE)
    ws.create_session("agent", mounts={"/a": "read"})

    async def run():
        return await ws.execute("echo leaked > /a/y.txt", session_id="agent")

    io = asyncio.run(run())
    assert io.exit_code != 0
    assert b"read-only" in (io.stderr or b"")
    assert "/y.txt" not in a._store.files


def test_write_grant_allows_write():
    a = _seed("x.txt", b"hi")
    ws = Workspace({"/a": (a, MountMode.WRITE)}, mode=MountMode.WRITE)
    ws.create_session("agent", mounts={"/a": MountMode.WRITE})

    async def run():
        return await ws.execute("echo new > /a/y.txt", session_id="agent")

    io = asyncio.run(run())
    assert io.exit_code == 0
    assert a._store.files.get("/y.txt") == b"new\n"


def test_grant_cannot_widen_read_mount():
    a = _seed("x.txt", b"hi")
    ws = Workspace({"/a": (a, MountMode.READ)})
    ws.create_session("agent", mounts={"/a": "write"})

    async def run():
        return await ws.execute("echo up > /a/y.txt", session_id="agent")

    io = asyncio.run(run())
    assert io.exit_code != 0
    assert b"read-only" in (io.stderr or b"")


def test_user_root_mount_governed_by_grants():
    root = _seed("root.txt", b"top\n")
    a = _seed("x.txt", b"hi")
    ws = Workspace({
        "/": (root, MountMode.WRITE),
        "/a": (a, MountMode.WRITE)
    },
                   mode=MountMode.WRITE)
    ws.create_session("no_root", mounts={"/a": "write"})
    ws.create_session("root_ro", mounts={"/a": "write", "/": "read"})

    async def run():
        denied = await ws.execute("cat /root.txt", session_id="no_root")
        read_ok = await ws.execute("cat /root.txt", session_id="root_ro")
        write_denied = await ws.execute("echo x > /root.txt",
                                        session_id="root_ro")
        return denied, read_ok, write_denied

    denied, read_ok, write_denied = asyncio.run(run())
    assert denied.exit_code != 0
    assert b"not allowed" in (denied.stderr or b"")
    assert read_ok.exit_code == 0 and b"top" in (read_ok.stdout or b"")
    assert write_denied.exit_code != 0
    assert b"read-only" in (write_denied.stderr or b"")


def test_implicit_root_keeps_pathless_commands_working():
    a = _seed("x.txt", b"hi")
    ws = Workspace({"/a": a})
    ws.create_session("agent", mounts={"/a": "read"})

    async def run():
        return await ws.execute("echo hi | wc -l", session_id="agent")

    io = asyncio.run(run())
    assert io.exit_code == 0
    assert (io.stdout or b"").strip() == b"1"


def test_exec_gate_is_per_session():
    a = _seed("x.txt", b"hi")
    ws = Workspace({"/e": (a, MountMode.EXEC)})
    ws.create_session("no_exec", mounts={"/e": "write"})
    ws.create_session("with_exec", mounts={"/e": "exec"})

    async def run():
        denied = await ws.execute("python -c 'print(1)'", session_id="no_exec")
        ok = await ws.execute("python -c 'print(1)'", session_id="with_exec")
        return denied, ok

    denied, ok = asyncio.run(run())
    assert denied.exit_code != 0
    assert ok.exit_code == 0 and b"1" in (ok.stdout or b"")


def test_ops_facade_respects_read_grant():
    a = _seed("x.txt", b"hi")
    ws = Workspace({"/a": (a, MountMode.WRITE)}, mode=MountMode.WRITE)
    sess = ws.create_session("agent", mounts={"/a": "read"})

    async def run():
        token = set_current_session(sess)
        try:
            assert await ws.ops.read("/a/x.txt") == b"hi"
            with pytest.raises(PermissionError, match="read-only"):
                await ws.ops.write("/a/y.txt", b"leaked")
            with pytest.raises(PermissionError, match="read-only"):
                await ws.ops.rename("/a/x.txt", "/a/z.txt")
        finally:
            reset_current_session(token)

    asyncio.run(run())


def test_invalid_role_rejected():
    a = _seed("x.txt", b"hi")
    ws = Workspace({"/a": a})
    with pytest.raises(ValueError):
        ws.create_session("agent", mounts={"/a": "admin"})


def test_filesystem_alias_roles():
    a = _seed("x.txt", b"hi")
    ws = Workspace({"/a": a})
    sess = ws.create_session("agent", mounts={"/a": "rw"})
    assert sess.mount_grants is not None
    assert sess.mount_grants["/a"] == MountMode.WRITE
    with pytest.raises(ValueError):
        ws.create_session("bits", mounts={"/a": "w"})
