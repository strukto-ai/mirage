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

import sys

import pytest

from mirage.config import WorkspaceConfig
from mirage.runtime.python import (LocalRuntime, MontyRuntime, WasiRuntime,
                                   select_python_runtime)
from mirage.runtime.python.local import LOCAL_HOME_ENV
from mirage.runtime.python.select import validate_runtime_home
from mirage.runtime.python.wasi import WASI_HOME_ENV


def test_default_is_monty():
    assert isinstance(select_python_runtime(None), MontyRuntime)


def test_select_local():
    assert isinstance(select_python_runtime("local"), LocalRuntime)


def test_select_monty_explicit():
    assert isinstance(select_python_runtime("monty"), MontyRuntime)


def test_select_wasi(monkeypatch, tmp_path):
    (tmp_path / "python.wasm").write_bytes(b"\0asm")
    (tmp_path / "lib" / "python3.14").mkdir(parents=True)
    monkeypatch.setenv(WASI_HOME_ENV, str(tmp_path))
    assert isinstance(select_python_runtime("wasi"), WasiRuntime)


def test_select_wasi_without_build_fails_loud(monkeypatch):
    monkeypatch.delenv(WASI_HOME_ENV, raising=False)
    with pytest.raises(FileNotFoundError, match="cpython-wasi-build"):
        select_python_runtime("wasi")


def test_select_wasi_home_entry_beats_env(monkeypatch, tmp_path):
    monkeypatch.delenv(WASI_HOME_ENV, raising=False)
    (tmp_path / "python.wasm").write_bytes(b"\0asm")
    (tmp_path / "lib" / "python3.14").mkdir(parents=True)
    rt = select_python_runtime("wasi", home={"wasi": str(tmp_path)})
    assert isinstance(rt, WasiRuntime)


def test_select_local_home_entry():
    rt = select_python_runtime("local", home={"local": sys.executable})
    assert isinstance(rt, LocalRuntime)


def test_select_local_unknown_interpreter_fails_loud(monkeypatch):
    monkeypatch.delenv(LOCAL_HOME_ENV, raising=False)
    with pytest.raises(FileNotFoundError, match="interpreter not found"):
        select_python_runtime("local", home={"local": "no-such-python-xyz"})


def test_home_entries_for_other_runtimes_are_ignored():
    rt = select_python_runtime("local",
                               home={
                                   "local": sys.executable,
                                   "pyodide":
                                   "https://cdn.example.com/pyodide/",
                               })
    assert isinstance(rt, LocalRuntime)


def test_home_rejects_monty_entry():
    with pytest.raises(ValueError, match="embeds its interpreter"):
        validate_runtime_home({"monty": "/somewhere"})


def test_home_rejects_unknown_runtime_name():
    with pytest.raises(ValueError, match="unknown runtime name in home"):
        select_python_runtime("monty", home={"docker": "/somewhere"})


def test_config_threads_wasi_home(monkeypatch, tmp_path):
    monkeypatch.delenv(WASI_HOME_ENV, raising=False)
    (tmp_path / "python.wasm").write_bytes(b"\0asm")
    (tmp_path / "lib" / "python3.14").mkdir(parents=True)
    cfg = WorkspaceConfig.model_validate({
        "mounts": {
            "/r": {
                "resource": "ram"
            }
        },
        "runtime": {
            "python": "wasi",
            "home": {
                "wasi": str(tmp_path)
            }
        },
    })
    kwargs = cfg.to_workspace_kwargs()
    assert kwargs["python_runtime"] == "wasi"
    assert kwargs["runtime_home"] == {"wasi": str(tmp_path)}


def test_config_threads_local_home():
    cfg = WorkspaceConfig.model_validate({
        "mounts": {
            "/r": {
                "resource": "ram"
            }
        },
        "runtime": {
            "python": "local",
            "home": {
                "local": sys.executable
            }
        },
    })
    kwargs = cfg.to_workspace_kwargs()
    assert kwargs["python_runtime"] == "local"
    assert kwargs["runtime_home"] == {"local": sys.executable}


def test_config_accepts_pyodide_home_entry():
    cfg = WorkspaceConfig.model_validate({
        "mounts": {
            "/r": {
                "resource": "ram"
            }
        },
        "runtime": {
            "python": "monty",
            "home": {
                "pyodide": "https://cdn.example.com/pyodide/"
            }
        },
    })
    kwargs = cfg.to_workspace_kwargs()
    assert kwargs["runtime_home"] == {
        "pyodide": "https://cdn.example.com/pyodide/"
    }


def test_config_rejects_monty_home_entry():
    with pytest.raises(ValueError, match="embeds its interpreter"):
        WorkspaceConfig.model_validate({
            "mounts": {
                "/r": {
                    "resource": "ram"
                }
            },
            "runtime": {
                "python": "monty",
                "home": {
                    "monty": "/somewhere"
                }
            },
        })


def test_unknown_name_raises():
    with pytest.raises(ValueError, match="unknown python runtime"):
        select_python_runtime("docker")


def test_pyodide_gets_cross_language_hint():
    with pytest.raises(ValueError, match="TypeScript-only"):
        select_python_runtime("pyodide")


def test_config_rejects_pyodide_at_load():
    with pytest.raises(ValueError, match="TypeScript-only"):
        WorkspaceConfig.model_validate({
            "mounts": {
                "/r": {
                    "resource": "ram"
                }
            },
            "runtime": {
                "python": "pyodide"
            },
        })
