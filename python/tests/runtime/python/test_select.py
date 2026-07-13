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

from mirage.runtime.python import (LocalRuntime, MontyRuntime,
                                   select_python_runtime)


def test_default_is_monty():
    assert isinstance(select_python_runtime(None), MontyRuntime)


def test_select_local():
    assert isinstance(select_python_runtime("local"), LocalRuntime)


def test_select_monty_explicit():
    assert isinstance(select_python_runtime("monty"), MontyRuntime)


def test_unknown_name_raises():
    with pytest.raises(ValueError, match="unknown python runtime"):
        select_python_runtime("docker")


def test_pyodide_gets_cross_language_hint():
    with pytest.raises(ValueError, match="TypeScript-only"):
        select_python_runtime("pyodide")


def test_config_rejects_pyodide_at_load():
    from mirage.config import WorkspaceConfig
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
