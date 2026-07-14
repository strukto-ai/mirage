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

import pytest

from mirage.config import WorkspaceConfig
from mirage.runtime.js import QuickJsRuntime, select_js_runtime
from mirage.runtime.js.quickjs import QUICKJS_HOME_ENV


def test_default_is_quickjs(monkeypatch, tmp_path):
    (tmp_path / "qjs-wasi.wasm").write_bytes(b"\0asm")
    monkeypatch.setenv(QUICKJS_HOME_ENV, str(tmp_path))
    assert isinstance(select_js_runtime(None), QuickJsRuntime)


def test_select_quickjs_explicit(monkeypatch, tmp_path):
    (tmp_path / "qjs-wasi.wasm").write_bytes(b"\0asm")
    monkeypatch.setenv(QUICKJS_HOME_ENV, str(tmp_path))
    assert isinstance(select_js_runtime("quickjs"), QuickJsRuntime)


def test_select_quickjs_home_option_beats_env(monkeypatch, tmp_path):
    monkeypatch.delenv(QUICKJS_HOME_ENV, raising=False)
    (tmp_path / "qjs-wasi.wasm").write_bytes(b"\0asm")
    rt = select_js_runtime("quickjs",
                           options={"quickjs": {
                               "home": str(tmp_path)
                           }})
    assert isinstance(rt, QuickJsRuntime)


def test_select_quickjs_without_build_fails_loud(monkeypatch):
    monkeypatch.delenv(QUICKJS_HOME_ENV, raising=False)
    with pytest.raises(FileNotFoundError, match="quickjs-ng"):
        select_js_runtime("quickjs")


def test_unknown_js_runtime_raises():
    with pytest.raises(ValueError, match="unknown js runtime"):
        select_js_runtime("v8")


def test_unknown_quickjs_option_fails_loud(monkeypatch, tmp_path):
    (tmp_path / "qjs-wasi.wasm").write_bytes(b"\0asm")
    monkeypatch.setenv(QUICKJS_HOME_ENV, str(tmp_path))
    with pytest.raises(ValueError, match="unknown quickjs runtime option"):
        select_js_runtime("quickjs", options={"quickjs": {"hom": "/typo"}})


def test_other_runtime_blocks_are_ignored(monkeypatch, tmp_path):
    (tmp_path / "qjs-wasi.wasm").write_bytes(b"\0asm")
    monkeypatch.setenv(QUICKJS_HOME_ENV, str(tmp_path))
    rt = select_js_runtime("quickjs",
                           options={"wasi": {
                               "home": "/opt/cpython-wasi"
                           }})
    assert isinstance(rt, QuickJsRuntime)


def test_config_threads_js_and_quickjs_block():
    cfg = WorkspaceConfig.model_validate({
        "mounts": {
            "/r": {
                "resource": "ram"
            }
        },
        "runtime": {
            "js": "quickjs",
            "quickjs": {
                "home": "/opt/qjs"
            }
        },
    })
    kwargs = cfg.to_workspace_kwargs()
    assert kwargs["js_runtime"] == "quickjs"
    assert kwargs["runtime_options"] == {"quickjs": {"home": "/opt/qjs"}}


def test_config_js_unset_is_graceful():
    cfg = WorkspaceConfig.model_validate({
        "mounts": {
            "/r": {
                "resource": "ram"
            }
        },
        "runtime": {
            "python": "monty"
        },
    })
    kwargs = cfg.to_workspace_kwargs()
    assert "js_runtime" not in kwargs


def test_config_rejects_unknown_js_runtime():
    with pytest.raises(ValueError, match="unknown js runtime"):
        WorkspaceConfig.model_validate({
            "mounts": {
                "/r": {
                    "resource": "ram"
                }
            },
            "runtime": {
                "js": "v8"
            },
        })
