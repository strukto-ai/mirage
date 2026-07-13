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

from typing import Callable

from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.python.local import LocalRuntime
from mirage.runtime.python.monty import MontyRuntime

DEFAULT_PYTHON_RUNTIME = MontyRuntime.name

PYTHON_RUNTIMES = (MontyRuntime.name, LocalRuntime.name)


def validate_python_runtime_name(name: str) -> str:
    """Check a runtime name, with a cross-language hint for TS names.

    Args:
        name (str): runtime name from config or the Workspace kwarg.

    Raises:
        ValueError: unknown runtime name.
    """
    if name in PYTHON_RUNTIMES:
        return name
    if name == "pyodide":
        raise ValueError(
            "python runtime 'pyodide' is TypeScript-only (a WASM CPython "
            "for runtimes without a host Python); Python supports 'monty' "
            "(sandboxed, default) and 'local' (the host CPython)")
    raise ValueError(f"unknown python runtime: {name!r} "
                     "(expected 'monty' or 'local')")


def select_python_runtime(name: str | None,
                          dispatch: Callable | None = None) -> PythonRuntime:
    """Build the Python runtime for a workspace.

    Args:
        name (str | None): runtime name; None means the default (monty).
        dispatch (Callable | None): workspace dispatch the sandboxed
            runtime bridges file I/O through. Ignored by `local`, which
            runs against the host filesystem.

    Raises:
        ValueError: unknown runtime name.
    """
    resolved = validate_python_runtime_name(name or DEFAULT_PYTHON_RUNTIME)
    if resolved == MontyRuntime.name:
        return MontyRuntime(dispatch)
    return LocalRuntime()
