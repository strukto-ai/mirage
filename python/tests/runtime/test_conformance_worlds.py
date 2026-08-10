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

import os
from pathlib import Path

import pytest

from mirage import MountMode, Workspace
from mirage.fuse.core import MountCore
from mirage.io.types import materialize
from mirage.resource.ram import RAMResource
from mirage.runtime.js.quickjs import QUICKJS_HOME_ENV
from mirage.runtime.python.wasi import WASI_HOME_ENV


def _wasi_available() -> bool:
    root = os.environ.get(WASI_HOME_ENV)
    return bool(root) and (Path(root) / "python.wasm").is_file()


def _quickjs_available() -> bool:
    root = os.environ.get(QUICKJS_HOME_ENV)
    return bool(root) and (Path(root) / "qjs-wasi.wasm").is_file()


wasi_live = pytest.mark.skipif(
    not _wasi_available(),
    reason=f"{WASI_HOME_ENV} does not point at a CPython WASI build")
quickjs_live = pytest.mark.skipif(
    not _quickjs_available(),
    reason=f"{QUICKJS_HOME_ENV} does not point at a quickjs WASI build")

# One world, three surfaces, one door. The suite pins the facts a mount
# tree must present identically through the shell (virtual commands),
# through a sandboxed guest (its own stdlib), and through a headless
# FUSE MountCore. A guest and the shell disagreeing about the same
# mount is the whole bug class the runtime-fs-unify arc exists to
# close, so the guest surface is verified against the SAME world the
# shell walks, never against the runtime's own report.
#
# Facts broken on main are marked xfail(strict=True) with the R-step
# that fixes them: the mark comes off as each step lands, and a fact
# that starts passing early fails loud instead of rotting as a silent
# xpass. R1 (mount structure into the door: readdir/stat merge child
# mounts and namespace links behind the session guard, fan-out and the
# ls fact session-filtered) has landed, which is why the structure and
# enumeration groups run unmarked. R2 = one guarded door for every op,
# closing the guest session leaks that remain (the thread-hop drops the
# session contextvar, so a guest reads and writes unscoped).

R2_GUEST = "R2: the guest thread-hop drops the session, so ops run unscoped"
CWD = "runtime cwd is not wired: guests resolve no relative paths"


def _seed(files: dict[str, bytes]) -> RAMResource:
    """A RAM resource preloaded with mount-relative files.

    Args:
        files (dict[str, bytes]): mount-relative path -> content.
    """
    r = RAMResource()
    for name, body in files.items():
        r._store.files[name] = body
    return r


def structure_world(runtime: str) -> Workspace:
    """A nested mount plus a namespace symlink, one backend file each.

    ``/base`` holds ``a.txt``; ``/base/inner`` is a second mount holding
    ``deep.txt``; ``/base/lnk`` is a namespace symlink to ``/base/inner``
    (created by the caller, since links are namespace state no backend
    reports). The point: ``inner`` and ``lnk`` are both discoverable
    only above the backend, so a surface that lists ``/base`` by asking
    one backend alone misses them.

    Args:
        runtime (str): registry name of the guest runtime to attach.
    """
    return Workspace(
        {
            "/base": _seed({"/a.txt": b"top"}),
            "/base/inner": _seed({"/deep.txt": b"needle"}),
        },
        mode=MountMode.EXEC,
        runtimes=[runtime, "vfs"],
    )


def scoped_world(runtime: str) -> Workspace:
    """Two mounts, a session granted only the first.

    ``/open`` (``pub.txt``) is granted to session ``agent``; ``/closed``
    (``sec.txt``) is not. ``/open/esc`` is a namespace symlink into
    ``/closed``, the cross-mount escape a confined guest must not be
    able to follow.

    Args:
        runtime (str): registry name of the guest runtime to attach.
    """
    ws = Workspace(
        {
            "/open": _seed({"/pub.txt": b"public"}),
            "/closed": _seed({"/sec.txt": b"SECRET-xyz"}),
        },
        mode=MountMode.EXEC,
        runtimes=[runtime, "vfs"],
    )
    ws.create_session("agent", mounts=["/open"])
    return ws


async def _sh(ws: Workspace,
              line: str,
              session_id: str | None = None) -> tuple[int, str, str]:
    """Run one shell line, returning exit code and decoded streams.

    Args:
        ws (Workspace): the world.
        line (str): the command line (a shell command or a guest one).
        session_id (str | None): session to run under, None for default.
    """
    kwargs = {"session_id": session_id} if session_id is not None else {}
    io = await ws.execute(line, **kwargs)
    out = (await materialize(io.stdout)).decode() if io.stdout else ""
    err = (await materialize(io.stderr)).decode() if io.stderr else ""
    return io.exit_code, out, err


GUARDS = {"monty": (), "wasi": (wasi_live, ), "quickjs": (quickjs_live, )}


def _guest_cases(spellings: dict[str, str]) -> list[object]:
    """Parametrize a guest line over the runtimes that can express it.

    Args:
        spellings (dict[str, str]): runtime name -> the guest line in
            that runtime's idiom. A runtime absent from the dict has no
            spelling for this fact and is skipped.
    """
    out: list[object] = []
    for runtime, line in spellings.items():
        out.append(
            pytest.param(runtime, line, id=runtime, marks=GUARDS[runtime]))
    return out


# ── Group 1: nested mount + namespace link are visible to every surface ──
#
# The shell and a headless FUSE readdir both merge structure today; the
# guest readdir does not, and that gap is the same one that hides a
# nested mount and a namespace symlink alike.


@pytest.mark.asyncio
async def test_shell_lists_child_mount_and_link():
    ws = structure_world("monty")
    try:
        code, out, _ = await _sh(ws, "ln -s /base/inner /base/lnk")
        assert code == 0
        code, out, _ = await _sh(ws, "ls /base")
        assert code == 0
        assert "a.txt" in out and "inner" in out and "lnk" in out
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_shell_walk_reaches_nested_descendant():
    ws = structure_world("monty")
    try:
        code, out, _ = await _sh(ws, "grep -r needle /base")
        assert code == 0
        assert "/base/inner/deep.txt" in out
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_fuse_readdir_merges_child_mount_and_link():
    ws = structure_world("monty")
    try:
        assert (await _sh(ws, "ln -s /base/inner /base/lnk"))[0] == 0
        core = MountCore(ws.ops)
        names = core.readdir("/base")
        assert "a.txt" in names and "inner" in names and "lnk" in names
        assert core.getattr("/base/inner")["st_mode"] & 0o040000
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "runtime,line",
    _guest_cases({
        "monty":
        "python3 -c \"from pathlib import Path; "
        "print(sorted(p.name for p in Path('/base').iterdir()))\"",
        "wasi":
        "python3 -c \"import os; print(sorted(os.listdir('/base')))\"",
        "quickjs":
        "node -e \"const [n] = os.readdir('/base'); "
        "console.log(n.sort().join(','))\"",
    }),
)
async def test_guest_lists_child_mount(runtime: str, line: str):
    """A guest listing ``/base`` must see the nested mount ``inner``.

    Args:
        runtime (str): guest runtime under test.
        line (str): the listing line in that runtime's idiom.
    """
    ws = structure_world(runtime)
    try:
        code, out, err = await _sh(ws, line)
        assert code == 0, err
        assert "inner" in out
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "runtime,line",
    _guest_cases({
        "monty":
        "python3 -c \"from pathlib import Path; "
        "print(sorted(p.name for p in Path('/base').iterdir()))\"",
        "wasi":
        "python3 -c \"import os; print(sorted(os.listdir('/base')))\"",
    }),
)
async def test_guest_lists_namespace_link(runtime: str, line: str):
    """A guest listing ``/base`` must see the namespace symlink ``lnk``.

    Args:
        runtime (str): guest runtime under test.
        line (str): the listing line in that runtime's idiom.
    """
    ws = structure_world(runtime)
    try:
        assert (await _sh(ws, "ln -s /base/inner /base/lnk"))[0] == 0
        code, out, err = await _sh(ws, line)
        assert code == 0, err
        assert "lnk" in out
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_guest_reads_through_link_by_exact_path():
    """Following a link by exact path already works: the door follows.

    This is the counterpart to the xfail above. Discovery (readdir) is
    broken, but resolution (follow) is not, which is why the fix is to
    complete readdir, not to teach the guest about links.
    """
    ws = structure_world("monty")
    try:
        assert (await _sh(ws, "ln -s /base/inner /base/lnk"))[0] == 0
        code, out, err = await _sh(
            ws, "python3 -c \"print(open('/base/lnk/deep.txt').read())\"")
        assert code == 0, err
        assert "needle" in out
    finally:
        await ws.close()


# ── Group 2: a structure-only directory stats as a directory ──


@pytest.mark.asyncio
async def test_door_stats_structure_only_directory():
    """``stat`` on a pure mount-prefix dir answers directory, not ENOENT.

    ``/base/inner`` exists because a mount sits there; the ``/base``
    backend holds nothing at that path. os.walk and Path.is_dir both
    depend on this, so it is the door's to answer.
    """
    ws = structure_world("monty")
    try:
        st = await ws.ops.stat("/base/inner")
        assert st.type.value == "directory"
        code, out, err = await _sh(
            ws, "python3 -c \"from pathlib import Path; "
            "print(Path('/base/inner').is_dir())\"")
        assert code == 0, err
        assert "True" in out
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_link_ancestors_synthesize_on_every_surface():
    """A link below an absent directory chain is reachable from above.

    ``ln`` permits ``/ghost/deep/lnk`` with no backend serving
    ``/ghost``; its ancestors synthesize exactly as nested mount
    prefixes do, so ``ls /`` shows the way in and a guest walk from
    the root reaches the link.
    """
    ws = structure_world("monty")
    try:
        assert (await _sh(ws, "ln -s /base/a.txt /ghost/deep/lnk"))[0] == 0
        st = await ws.ops.stat("/ghost")
        assert st.type.value == "directory"
        code, out, _ = await _sh(ws, "ls /")
        assert code == 0
        assert "ghost" in out
        code, out, _ = await _sh(ws, "ls /ghost")
        assert code == 0
        assert "deep" in out
        code, out, err = await _sh(
            ws, "python3 -c \"from pathlib import Path; "
            "print(sorted(str(p) for p in Path('/ghost').iterdir()))\"")
        assert code == 0, err
        assert "/ghost/deep" in out
    finally:
        await ws.close()


# ── Group 3: a scoped session confines every surface ──
#
# Explicit operands and the headless FUSE core are confined today. The
# fan-out shell commands and the guest are not: they reach an ungranted
# mount's names, bytes and sizes, and the guest can even write there.


@pytest.mark.asyncio
@pytest.mark.parametrize("line", [
    "cat /closed/sec.txt",
    "ls /closed",
    "grep -r SECRET /closed",
    "find /closed",
    "du /closed",
])
async def test_explicit_operand_at_boundary_is_denied(line: str):
    """A named operand on an ungranted mount is refused out loud.

    Args:
        line (str): the shell line naming ``/closed`` directly.
    """
    ws = scoped_world("monty")
    try:
        code, _, err = await _sh(ws, line, session_id="agent")
        assert code != 0
        assert "not allowed" in err and "/closed" in err
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_fuse_core_confines_ungranted_mount():
    ws = scoped_world("monty")
    try:
        sess = ws.get_session("agent")
        core = MountCore(ws.ops, session=sess)
        with pytest.raises(PermissionError):
            core.readdir("/closed")
        with pytest.raises(PermissionError):
            fh = core.open("/closed/sec.txt")
            core.read("/closed/sec.txt", 4096, 0, fh)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_scoped_session_hides_name_from_root_listing():
    ws = scoped_world("monty")
    try:
        code, out, _ = await _sh(ws, "ls /", session_id="agent")
        assert code == 0
        assert "open" in out
        assert "closed" not in out
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_scoped_link_below_ungranted_mount_stays_hidden():
    """A namespace link under an ungranted mount must not leak its name.

    ``child_mount_names`` already hides ``/closed`` itself; a link at
    ``/closed/leak`` is namespace state above the backend, but its path
    discloses the same name, so the same grant filters it. The
    unrestricted view keeps the link.
    """
    ws = scoped_world("monty")
    try:
        assert (await _sh(ws, "ln -s /closed/sec.txt /closed/leak"))[0] == 0
        code, out, _ = await _sh(ws, "ls /", session_id="agent")
        assert code == 0
        assert "closed" not in out
        code, out, _ = await _sh(ws, "ls /")
        assert code == 0
        assert "closed" in out
    finally:
        await ws.close()


def granted_child_world(runtime: str) -> Workspace:
    """An ungranted parent mount with a granted child nested inside.

    ``/base`` (``a.txt``) is not granted to session ``agent``;
    ``/base/inner`` (``deep.txt``) is. The root listing deliberately
    shows ``base`` as the traversal path to the grant, so the walk down
    through ``/base`` must answer with structure and nothing of the
    parent's own content.

    Args:
        runtime (str): registry name of the guest runtime to attach.
    """
    ws = Workspace(
        {
            "/base": _seed({"/a.txt": b"top"}),
            "/base/inner": _seed({"/deep.txt": b"needle"}),
        },
        mode=MountMode.EXEC,
        runtimes=[runtime, "vfs"],
    )
    ws.create_session("agent", mounts=["/base/inner"])
    return ws


@pytest.mark.asyncio
async def test_scoped_walk_reaches_nested_grant():
    """An ungranted parent with a granted child serves its structure.

    Refusing ``/base`` strands the session outside its own mount, and
    serving the backend would leak ungranted content; the answer is
    the granted structure and nothing else.
    """
    ws = granted_child_world("monty")
    try:
        sess = ws.get_session("agent")
        core = MountCore(ws.ops, session=sess)
        names = core.readdir("/base")
        assert "inner" in names
        assert "a.txt" not in names
        assert core.getattr("/base")["st_mode"] & 0o040000
        assert "deep.txt" in core.readdir("/base/inner")
        with pytest.raises(PermissionError):
            core.getattr("/base/a.txt")
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("line,needle", [
    ("grep -r SECRET /", "SECRET-xyz"),
    ("ls -R /", "sec.txt"),
    ("find /", "/closed/sec.txt"),
    ("du -a /", "/closed"),
])
async def test_fanout_does_not_cross_boundary(line: str, needle: str):
    """A fan-out from ``/`` must not surface an ungranted mount.

    Args:
        line (str): the recursive shell line rooted above the boundary.
        needle (str): the ``/closed`` fact that must not appear.
    """
    ws = scoped_world("monty")
    try:
        code, out, _ = await _sh(ws, line, session_id="agent")
        assert needle not in out
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "runtime,line",
    _guest_cases({
        "monty":
        "python3 -c \"print(open('/closed/sec.txt').read())\"",
        "wasi":
        "python3 -c \"print(open('/closed/sec.txt').read())\"",
        "quickjs":
        "node -e \"const f = std.open('/closed/sec.txt', 'r'); "
        "console.log(f.readAsString())\"",
    }),
)
@pytest.mark.xfail(reason=R2_GUEST, strict=True)
async def test_guest_cannot_read_ungranted_mount(runtime: str, line: str):
    """A confined guest reading ``/closed`` must be refused, not served.

    Args:
        runtime (str): guest runtime under test.
        line (str): the read line in that runtime's idiom.
    """
    ws = scoped_world(runtime)
    try:
        code, out, _ = await _sh(ws, line, session_id="agent")
        assert code != 0
        assert "SECRET-xyz" not in out
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.xfail(reason=R2_GUEST, strict=True)
async def test_guest_cannot_write_ungranted_mount():
    ws = scoped_world("monty")
    try:
        line = ("python3 -c \"from pathlib import Path; "
                "Path('/closed/planted.txt').write_text('X')\"")
        await _sh(ws, line, session_id="agent")
        code, out, _ = await _sh(ws, "ls /closed")
        assert code == 0
        assert "planted.txt" not in out
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.xfail(reason=R2_GUEST, strict=True)
async def test_guest_cannot_follow_link_out_of_scope():
    """A cross-mount symlink is not an escape hatch from confinement."""
    ws = scoped_world("monty")
    try:
        assert (await _sh(ws, "ln -s /closed /open/esc"))[0] == 0
        code, out, _ = await _sh(
            ws,
            "python3 -c \"print(open('/open/esc/sec.txt').read())\"",
            session_id="agent")
        assert code != 0
        assert "SECRET-xyz" not in out
    finally:
        await ws.close()


# ── Group 4: a guest resolves relative paths against its cwd (forward) ──
#
# The shell has a cwd; the guest never receives it. Relative-path ops
# in a guest fail today. Pinned as the fact a cwd-carrying door must
# satisfy, so the wiring lands with a test already waiting for it.


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "runtime,line",
    _guest_cases({
        "monty":
        "cd /base && python3 -c \"print(open('a.txt').read())\"",
        "wasi":
        "cd /base && python3 -c \"print(open('a.txt').read())\"",
    }),
)
@pytest.mark.xfail(reason=CWD, strict=True)
async def test_guest_resolves_relative_path_against_cwd(
        runtime: str, line: str):
    """A guest launched in ``/base`` reads ``a.txt`` relatively.

    Args:
        runtime (str): guest runtime under test.
        line (str): the relative-read line in that runtime's idiom.
    """
    ws = structure_world(runtime)
    try:
        code, out, err = await _sh(ws, line)
        assert code == 0, err
        assert "top" in out
    finally:
        await ws.close()
