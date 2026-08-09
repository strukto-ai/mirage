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
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from mirage import MountMode, Workspace
from mirage.io.types import materialize
from mirage.resource.ram import RAMResource
from mirage.runtime.js.quickjs import QUICKJS_HOME_ENV
from mirage.runtime.python.wasi import WASI_HOME_ENV
from mirage.runtime.table import build_runtime
from mirage.runtime.types import RunArgs
from mirage.types import FileStat, FileType


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

GUARDS = {"monty": (), "wasi": (wasi_live, ), "quickjs": (quickjs_live, )}

APPEND_AMPLIFIED = (
    "the shared wasm transport has no append op: every open-for-append "
    "close re-flushes the whole file, so n appends ship O(n^2) bytes")


@dataclass(frozen=True, slots=True)
class Row:
    """One capability row: a mutation in the runtime's own idiom.

    The runtime line mutates, the shell verifies: assertions are made
    on the mount through a shell command, never through the runtime
    that wrote it, because the bug class is a runtime that mutates its
    own private tree and reports success.

    Args:
        capability (str): the capability under test (mkdir, unlink,
            rename-cross, ...), spelled the same in both languages.
        spelling (str): the guest API spelling this row exercises. The
            spelling axis is the point of the suite: which spellings a
            runtime intercepts is exactly what diverges.
        line (str): the interpreter command that performs the mutation.
        setup (tuple[str, ...]): shell lines seeding the world.
        exit_code (int): expected exit of the runtime line.
        line_out (str | None): substring expected on the line's stdout.
        checks (tuple[tuple[str, str], ...]): shell verifications as
            (command, want) pairs; a want of "!x" asserts x is absent.
            Every command must itself exit 0, or an absence want would
            be satisfied by the empty stdout of a failed check.
    """

    capability: str
    spelling: str
    line: str
    setup: tuple[str, ...] = ()
    exit_code: int = 0
    line_out: str | None = None
    checks: tuple[tuple[str, str], ...] = ()


@dataclass
class CountingDispatch:
    """Dispatch stub that records every op and the bytes it carried.

    The seam for the append row: every runtime takes the dispatch as an
    injected callable, so byte accounting needs no new hook. Supports
    the full op vocabulary the runtimes emit, which both tiers now
    reach through RuntimeVFS.

    Args:
        files (dict[str, bytes]): initial virtual file contents.
    """

    files: dict[str, bytes]
    dirs: set[str] = field(default_factory=set)
    ops: list[tuple[str, str, int]] = field(default_factory=list)

    async def __call__(self, op, path, **kwargs):
        virtual = path.virtual
        payload = kwargs.get("data")
        size = len(payload) if payload is not None else 0
        self.ops.append((op, virtual, size))
        if op == "read":
            if virtual not in self.files:
                raise FileNotFoundError(virtual)
            return self.files[virtual], None
        if op == "stat":
            return self._stat(virtual), None
        if op == "readdir":
            prefix = virtual.rstrip("/") + "/"
            names = {
                p[len(prefix):].split("/")[0]
                for p in self.files if p.startswith(prefix)
            }
            return sorted(names), None
        if op == "write":
            self.files[virtual] = bytes(payload)
            return None, None
        if op == "append":
            self.files[virtual] = self.files.get(virtual, b"") + bytes(payload)
            return None, None
        if op == "create":
            self.files.setdefault(virtual, b"")
            return None, None
        if op == "truncate":
            self.files[virtual] = b""
            return None, None
        if op == "unlink":
            self.files.pop(virtual, None)
            return None, None
        if op == "mkdir":
            self.dirs.add(virtual)
            return None, None
        if op == "rmdir":
            self.dirs.discard(virtual)
            return None, None
        if op == "rename":
            dst = kwargs["dst"].virtual
            self.files[dst] = self.files.pop(virtual)
            return None, None
        raise ValueError(f"unexpected op {op}")

    def _stat(self, virtual: str) -> FileStat:
        if virtual in self.files:
            return FileStat(name=virtual.rsplit("/", 1)[-1],
                            size=len(self.files[virtual]),
                            type=FileType.TEXT)
        trimmed = virtual.rstrip("/")
        is_dir = trimmed in self.dirs or any(
            p.startswith(trimmed + "/") for p in self.files)
        if not is_dir:
            raise FileNotFoundError(virtual)
        return FileStat(name=trimmed.rsplit("/", 1)[-1],
                        type=FileType.DIRECTORY)

    def mutation_bytes(self) -> int:
        return sum(size for op, _, size in self.ops
                   if op in ("write", "append", "create", "truncate"))

    def mutation_ops(self) -> list[str]:
        return [
            op for op, _, _ in self.ops
            if op in ("write", "append", "create", "truncate")
        ]


MONTY_ROWS = (
    Row("mkdir",
        "Path.mkdir",
        "python3 -c \"from pathlib import Path; Path('/data/made').mkdir()\"",
        checks=(("ls /data", "made"), )),
    Row("unlink",
        "Path.unlink", "python3 -c "
        "\"from pathlib import Path; Path('/data/gone.txt').unlink()\"",
        setup=("echo -n x > /data/gone.txt", ),
        checks=(("ls /data", "!gone.txt"), )),
    Row("rmdir",
        "Path.rmdir", "python3 -c \"from pathlib import Path; "
        "Path('/data/hollow').rmdir()\"",
        setup=("mkdir /data/hollow", ),
        checks=(("ls /data", "!hollow"), )),
    Row("rename",
        "Path.rename", "python3 -c \"from pathlib import Path; "
        "Path('/data/a.txt').rename('/data/b.txt')\"",
        setup=("echo -n one > /data/a.txt", ),
        checks=(("cat /data/b.txt", "one"), ("ls /data", "!a.txt"))),
    Row("rename-cross",
        "Path.rename", "python3 -c \"from pathlib import Path; "
        "Path('/data/c.txt').rename('/other/c.txt')\"",
        setup=("echo -n keep > /data/c.txt", ),
        exit_code=1,
        checks=(("cat /data/c.txt", "keep"), ("ls /other", "!c.txt"))),
    Row("read",
        "open",
        "python3 -c \"print(open('/data/r.txt').read())\"",
        setup=("echo -n seen > /data/r.txt", ),
        line_out="seen"),
    Row("write",
        "open", "python3 -c \"f = open('/data/w1.txt', 'w'); "
        "f.write('data'); f.close()\"",
        checks=(("cat /data/w1.txt", "data"), )),
    Row("write",
        "Path.write_text", "python3 -c \"from pathlib import Path; "
        "Path('/data/w2.txt').write_text('data')\"",
        checks=(("cat /data/w2.txt", "data"), )),
    Row("write-readonly",
        "open",
        "python3 -c \"open('/ro/x.txt', 'w').write('nope')\"",
        exit_code=1,
        checks=(("ls /ro", "!x.txt"), )),
    Row("write-readonly",
        "Path.write_text", "python3 -c \"from pathlib import Path; "
        "Path('/ro/y.txt').write_text('nope')\"",
        exit_code=1,
        checks=(("ls /ro", "!y.txt"), )),
    Row("stat",
        "Path.stat", "python3 -c \"from pathlib import Path; "
        "print(Path('/data/st.txt').stat().st_size)\"",
        setup=("echo -n four > /data/st.txt", ),
        line_out="4"),
    Row("append",
        "open", "python3 -c \"\nfor part in ['b', 'c', 'd']:\n"
        "    with open('/data/log.txt', 'a') as f:\n"
        "        f.write(part)\n\"",
        setup=("echo -n a > /data/log.txt", ),
        checks=(("cat /data/log.txt", "abcd"), )),
    Row("append-preserves",
        "open", "python3 -c \"f = open('/data/keep.txt', 'a'); "
        "f.write('Z'); f.close()\"",
        setup=("echo -n a > /data/keep.txt", ),
        checks=(("cat /data/keep.txt", "aZ"), )),
)

WASI_ROWS = (
    Row("mkdir",
        "os.mkdir",
        "python3 -c \"import os; os.mkdir('/data/m1')\"",
        checks=(("ls /data", "m1"), )),
    Row("mkdir",
        "os.makedirs",
        "python3 -c \"import os; os.makedirs('/data/m2/deep')\"",
        checks=(("ls /data/m2", "deep"), )),
    Row("mkdir",
        "Path.mkdir",
        "python3 -c \"from pathlib import Path; Path('/data/m3').mkdir()\"",
        checks=(("ls /data", "m3"), )),
    Row("unlink",
        "os.remove",
        "python3 -c \"import os; os.remove('/data/f1.txt')\"",
        setup=("echo -n x > /data/f1.txt", ),
        checks=(("ls /data", "!f1.txt"), )),
    Row("unlink",
        "Path.unlink", "python3 -c "
        "\"from pathlib import Path; Path('/data/f2.txt').unlink()\"",
        setup=("echo -n x > /data/f2.txt", ),
        checks=(("ls /data", "!f2.txt"), )),
    Row("rmdir",
        "os.rmdir",
        "python3 -c \"import os; os.rmdir('/data/d1')\"",
        setup=("mkdir /data/d1", ),
        checks=(("ls /data", "!d1"), )),
    Row("rmdir",
        "Path.rmdir",
        "python3 -c \"from pathlib import Path; Path('/data/d2').rmdir()\"",
        setup=("mkdir /data/d2", ),
        checks=(("ls /data", "!d2"), )),
    Row("rmdir",
        "shutil.rmtree",
        "python3 -c \"import shutil; shutil.rmtree('/data/d3')\"",
        setup=("mkdir /data/d3", "echo -n x > /data/d3/inner.txt"),
        checks=(("ls /data", "!d3"), )),
    Row("rename",
        "os.rename",
        "python3 -c \"import os; os.rename('/data/a1.txt', '/data/b1.txt')\"",
        setup=("echo -n one > /data/a1.txt", ),
        checks=(("cat /data/b1.txt", "one"), ("ls /data", "!a1.txt"))),
    Row("rename",
        "os.replace",
        "python3 -c \"import os; os.replace('/data/a2.txt', '/data/b2.txt')\"",
        setup=("echo -n one > /data/a2.txt", ),
        checks=(("cat /data/b2.txt", "one"), )),
    Row("rename",
        "Path.rename", "python3 -c \"from pathlib import Path; "
        "Path('/data/a3.txt').rename('/data/b3.txt')\"",
        setup=("echo -n one > /data/a3.txt", ),
        checks=(("cat /data/b3.txt", "one"), )),
    Row("rename",
        "shutil.move", "python3 -c \"import shutil; "
        "shutil.move('/data/a4.txt', '/data/b4.txt')\"",
        setup=("echo -n one > /data/a4.txt", ),
        checks=(("cat /data/b4.txt", "one"), )),
    Row("rename-cross",
        "os.rename",
        "python3 -c \"import os; os.rename('/data/c.txt', '/other/c.txt')\"",
        setup=("echo -n keep > /data/c.txt", ),
        exit_code=1,
        checks=(("cat /data/c.txt", "keep"), ("ls /other", "!c.txt"))),
    Row("read",
        "open",
        "python3 -c \"print(open('/data/r.txt').read())\"",
        setup=("echo -n seen > /data/r.txt", ),
        line_out="seen"),
    Row("write",
        "open", "python3 -c \"f = open('/data/w1.txt', 'w'); "
        "f.write('data'); f.close()\"",
        checks=(("cat /data/w1.txt", "data"), )),
    Row("write",
        "Path.write_text", "python3 -c \"from pathlib import Path; "
        "Path('/data/w2.txt').write_text('data')\"",
        checks=(("cat /data/w2.txt", "data"), )),
    Row("write-readonly",
        "open",
        "python3 -c \"open('/ro/x.txt', 'w').write('nope')\"",
        exit_code=1,
        checks=(("ls /ro", "!x.txt"), )),
    Row("stat",
        "Path.stat", "python3 -c \"from pathlib import Path; "
        "print(Path('/data/st.txt').stat().st_size)\"",
        setup=("echo -n four > /data/st.txt", ),
        line_out="4"),
    Row("append",
        "open", "python3 -c \"\nfor part in ['b', 'c', 'd']:\n"
        "    with open('/data/log.txt', 'a') as f:\n"
        "        f.write(part)\n\"",
        setup=("echo -n a > /data/log.txt", ),
        checks=(("cat /data/log.txt", "abcd"), )),
    Row("append-preserves",
        "open", "python3 -c \"f = open('/data/keep.txt', 'a'); "
        "f.write('Z'); f.close()\"",
        setup=("echo -n a > /data/keep.txt", ),
        checks=(("cat /data/keep.txt", "aZ"), )),
)

QUICKJS_ROWS = (
    Row("mkdir",
        "os.mkdir", "node -e \"const rc = os.mkdir('/data/m1'); "
        "if (rc !== 0) throw new Error('rc ' + rc)\"",
        checks=(("ls /data", "m1"), )),
    Row("unlink",
        "os.remove", "node -e \"const rc = os.remove('/data/f1.txt'); "
        "if (rc !== 0) throw new Error('rc ' + rc)\"",
        setup=("echo -n x > /data/f1.txt", ),
        checks=(("ls /data", "!f1.txt"), )),
    Row("rmdir",
        "os.remove", "node -e \"const rc = os.remove('/data/d1'); "
        "if (rc !== 0) throw new Error('rc ' + rc)\"",
        setup=("mkdir /data/d1", ),
        checks=(("ls /data", "!d1"), )),
    Row("rename",
        "os.rename",
        "node -e \"const rc = os.rename('/data/a1.txt', '/data/b1.txt'); "
        "if (rc !== 0) throw new Error('rc ' + rc)\"",
        setup=("echo -n one > /data/a1.txt", ),
        checks=(("cat /data/b1.txt", "one"), ("ls /data", "!a1.txt"))),
    Row("rename-cross",
        "os.rename",
        "node -e \"console.log(os.rename('/data/c.txt', '/other/c.txt'))\"",
        setup=("echo -n keep > /data/c.txt", ),
        line_out="-44",
        checks=(("cat /data/c.txt", "keep"), ("ls /other", "!c.txt"))),
    Row("read",
        "std.open", "node -e \"const f = std.open('/data/r.txt', 'r'); "
        "console.log(f.readAsString()); f.close()\"",
        setup=("echo -n seen > /data/r.txt", ),
        line_out="seen"),
    Row("write",
        "std.open", "node -e \"const w = std.open('/data/w1.txt', 'w'); "
        "w.puts('data'); w.close()\"",
        checks=(("cat /data/w1.txt", "data"), )),
    Row("write-readonly",
        "std.open",
        "node -e \"const e = {}; const w = std.open('/ro/x.txt', 'w', e); "
        "console.log(w === null, e.errno)\"",
        line_out="true 2",
        checks=(("ls /ro", "!x.txt"), )),
    Row("stat",
        "os.stat", "node -e \"const [st, e] = os.stat('/data/st.txt'); "
        "console.log(e, st.size)\"",
        setup=("echo -n four > /data/st.txt", ),
        line_out="0 4"),
    Row("append",
        "std.open", "node -e \"for (const part of ['b', 'c', 'd']) { "
        "const w = std.open('/data/log.txt', 'a'); "
        "w.puts(part); w.close() }\"",
        setup=("echo -n a > /data/log.txt", ),
        checks=(("cat /data/log.txt", "abcd"), )),
    Row("append-preserves",
        "std.open", "node -e \"const w = std.open('/data/keep.txt', 'a'); "
        "w.puts('Z'); w.close()\"",
        setup=("echo -n a > /data/keep.txt", ),
        checks=(("cat /data/keep.txt", "aZ"), )),
)


def _world(runtime: str) -> Workspace:
    return Workspace(
        {
            "/data": RAMResource(),
            "/other": RAMResource(),
            "/ro": (RAMResource(), MountMode.READ),
        },
        mode=MountMode.EXEC,
        runtimes=[runtime, "vfs"],
    )


async def _sh(ws: Workspace, line: str) -> tuple[int, str]:
    io = await ws.execute(line)
    out = (await materialize(io.stdout)).decode()
    return io.exit_code, out


def _rows():
    out = []
    tables = (("monty", MONTY_ROWS), ("wasi", WASI_ROWS), ("quickjs",
                                                           QUICKJS_ROWS))
    for runtime, rows in tables:
        for row in rows:
            out.append(
                pytest.param(runtime,
                             row,
                             id=f"{runtime}-{row.capability}-{row.spelling}",
                             marks=GUARDS[runtime]))
    return out


@pytest.mark.asyncio
@pytest.mark.parametrize("runtime,row", _rows())
async def test_capability_reaches_the_mount(runtime: str, row: Row):
    """One mutation in the runtime's idiom, verified through the shell.

    Args:
        runtime (str): registry name of the runtime under test.
        row (Row): the capability row to execute.
    """
    ws = _world(runtime)
    try:
        for line in row.setup:
            code, out = await _sh(ws, line)
            assert code == 0, f"setup failed: {line}: {out}"
        code, out = await _sh(ws, row.line)
        assert code == row.exit_code, f"{row.line}: exit {code}: {out}"
        if row.line_out is not None:
            assert row.line_out in out
        for cmd, want in row.checks:
            code, seen = await _sh(ws, cmd)
            # An absence assertion over the stdout of a command that
            # failed is vacuous: a mount the mutation damaged answers
            # nothing, and "x is gone" then holds for every x.
            assert code == 0, f"check failed: {cmd}: exit {code}: {seen}"
            if want.startswith("!"):
                assert want[1:] not in seen, f"{cmd}: unexpected {want[1:]}"
            else:
                assert want in seen, f"{cmd}: wanted {want}, saw {seen!r}"
    finally:
        await ws.close()


ROOT_WRITE_PY = ("from pathlib import Path\n"
                 "Path('/mine.txt').write_text('R')")
ROOT_WRITE_JS = ("const w = std.open('/mine.txt', 'w'); "
                 "w.puts('R'); w.close()")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "runtime",
    [
        pytest.param("monty"),
        pytest.param("wasi", marks=wasi_live),
        pytest.param("quickjs", marks=quickjs_live),
    ],
)
async def test_a_root_mount_is_served_like_any_other(runtime: str):
    """A mount at `/` reaches the guest, and the shell sees the write.

    `/` is the one prefix a runtime could plausibly treat as its own,
    so it is the one worth pinning: wasi has a build directory rooted
    there and pyodide (TypeScript) has Emscripten's filesystem. Neither
    may swallow a mount the embedder actually made. Verified through
    the shell rather than the runtime, so a runtime that wrote only to
    its own private tree fails here.

    Args:
        runtime (str): registry name of the runtime under test.
    """
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[runtime, "vfs"])
    try:
        line = ROOT_WRITE_JS if runtime == "quickjs" else ROOT_WRITE_PY
        prefix = "node -e" if runtime == "quickjs" else "python3 -c"
        code, out = await _sh(ws, f'{prefix} "{line}"')
        assert code == 0, f"{line}: exit {code}: {out}"
        code, seen = await _sh(ws, "cat /mine.txt")
        assert code == 0, f"cat failed: {seen}"
        assert "R" in seen
    finally:
        await ws.close()


APPEND_LOOP_PY = ("for i in range(8):\n"
                  "    with open('/data/log.txt', 'a') as f:\n"
                  "        f.write('xyz')")
APPEND_LOOP_JS = ("for (let i = 0; i < 8; i++) { "
                  "const w = std.open('/data/log.txt', 'a'); "
                  "w.puts('xyz'); w.close() }")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "runtime",
    [
        pytest.param("monty"),
        pytest.param("wasi", marks=wasi_live),
        pytest.param("quickjs", marks=quickjs_live),
    ],
)
async def test_append_ships_only_the_deltas(runtime: str):
    """Eight appends of three bytes must ship 24 bytes, not O(n^2).

    The dispatch is counted rather than the outcome compared: every
    amplifying runtime still produces the right final content, so the
    file alone cannot distinguish one append from a full rewrite per
    close.

    Args:
        runtime (str): registry name of the runtime under test.
    """
    dispatch = CountingDispatch({"/data/log.txt": b"S" * 64})
    rt = build_runtime(runtime)
    rt.attach(dispatch, lambda: ["/data/"])
    code = APPEND_LOOP_JS if runtime == "quickjs" else APPEND_LOOP_PY
    result = await rt.run(RunArgs(code=code))
    await rt.close()
    assert result.exit_code == 0, result.stderr
    assert dispatch.files["/data/log.txt"] == b"S" * 64 + b"xyz" * 8
    assert dispatch.mutation_bytes() == 24, dispatch.mutation_ops()
