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
import os
from pathlib import Path

import pytest

from mirage import MountMode, Workspace
from mirage.resource.ram import RAMResource
from mirage.runtime.js import JsRunArgs, QuickJsRuntime
from mirage.runtime.js.quickjs import QUICKJS_HOME_ENV


def _home_dir() -> str | None:
    root = os.environ.get(QUICKJS_HOME_ENV)
    if root and (Path(root) / "qjs-wasi.wasm").is_file():
        return root
    return None


live = pytest.mark.skipif(
    _home_dir() is None,
    reason=f"{QUICKJS_HOME_ENV} does not point at a qjs-wasi.wasm build")


def test_missing_home_raises_hint(monkeypatch):
    monkeypatch.delenv(QUICKJS_HOME_ENV, raising=False)
    with pytest.raises(FileNotFoundError, match="quickjs-ng"):
        QuickJsRuntime()


def test_dir_without_wasm_raises_hint(tmp_path):
    with pytest.raises(FileNotFoundError, match="no qjs-wasi.wasm"):
        QuickJsRuntime(home=str(tmp_path))


@live
def test_quickjs_runs_modern_js():
    rt = QuickJsRuntime()
    code = (
        "const f = (n) => n * 6 + 1; "
        "console.log(JSON.stringify([...'ab'].map((s, i) => s + i)), f(6))")
    result = asyncio.run(rt.run(JsRunArgs(code=code)))
    assert result.exit_code == 0
    assert result.stdout == b'["a0","b1"] 37\n'
    assert result.stderr is None


@live
def test_quickjs_argv_stdin_module():
    rt = QuickJsRuntime()
    result = asyncio.run(
        rt.run(
            JsRunArgs(code="console.log(scriptArgs.join('/'))",
                      args=["a1", "a2"])))
    assert result.stdout == b"a1/a2\n"
    # std.in reads piped stdin (the std/os globals are exposed).
    result = asyncio.run(
        rt.run(
            JsRunArgs(
                code="console.log(std.in.readAsString().trim().toUpperCase())",
                stdin=b"piped\n")))
    assert result.stdout == b"PIPED\n"
    # module mode enables top-level await.
    result = asyncio.run(
        rt.run(
            JsRunArgs(
                code="const x = await Promise.resolve(41); console.log(x + 1)",
                module=True)))
    assert result.stdout == b"42\n"


@live
def test_quickjs_exit_code_and_error():
    rt = QuickJsRuntime()
    result = asyncio.run(rt.run(JsRunArgs(code="std.exit(7)")))
    assert result.exit_code == 7
    result = asyncio.run(rt.run(JsRunArgs(code="this is not js")))
    assert result.exit_code == 1
    assert b"SyntaxError" in (result.stderr or b"")


@live
def test_quickjs_host_fs_invisible():
    rt = QuickJsRuntime()
    # No preopens: the guest filesystem is empty, so a host path cannot
    # be opened (std.open returns null rather than a handle).
    result = asyncio.run(
        rt.run(
            JsRunArgs(
                code="console.log(std.open('/etc/passwd', 'r') === null)")))
    assert result.exit_code == 0
    assert result.stdout == b"true\n"


@live
@pytest.mark.asyncio
async def test_quickjs_node_command_end_to_end():
    ram = RAMResource()
    ram._store.files["/calc.mjs"] = (
        b"export const k = 6;\n"
        b"console.log(Number(scriptArgs[0]) * k)\n")
    ws = Workspace({"/ram": ram}, mode=MountMode.EXEC, js_runtime="quickjs")
    r = await ws.execute("node -e \"console.log('js says', 6 * 7)\"")
    assert r.exit_code == 0
    assert (await r.stdout_str()) == "js says 42\n"
    # A mounted .mjs resolves through the workspace and runs in module mode.
    r2 = await ws.execute("node /ram/calc.mjs 7")
    assert r2.exit_code == 0
    assert (await r2.stdout_str()) == "42\n"
    await ws.close()


@live
@pytest.mark.asyncio
async def test_quickjs_cancellation_stops_the_guest():
    rt = QuickJsRuntime()
    task = asyncio.ensure_future(rt.run(JsRunArgs(code="for (;;) {}")))
    await asyncio.sleep(0.5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    result = await rt.run(JsRunArgs(code="console.log('alive')"))
    assert result.exit_code == 0
    assert result.stdout == b"alive\n"


@live
def test_quickjs_reuses_compiled_module():
    rt = QuickJsRuntime()
    first = asyncio.run(rt.run(JsRunArgs(code="console.log(1)")))
    second = asyncio.run(rt.run(JsRunArgs(code="console.log(2)")))
    assert (first.stdout, second.stdout) == (b"1\n", b"2\n")
    root = _home_dir()
    assert root is not None
    assert (Path(root) / "qjs-wasi.cwasm").is_file()
