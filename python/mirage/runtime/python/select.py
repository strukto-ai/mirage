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
from mirage.runtime.python.wasi import WasiRuntime

DEFAULT_PYTHON_RUNTIME = MontyRuntime.name

PYTHON_RUNTIMES = (MontyRuntime.name, WasiRuntime.name, LocalRuntime.name)

# Runtimes (either language) that locate their interpreter or
# distribution through a `home` entry. Monty embeds its interpreter, so
# it never appears here.
RUNTIME_HOME_KEYS = (WasiRuntime.name, LocalRuntime.name, "pyodide")


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
            "(sandboxed, default), 'wasi' (sandboxed full CPython), and "
            "'local' (the host CPython)")
    raise ValueError(f"unknown python runtime: {name!r} "
                     "(expected 'monty', 'wasi', or 'local')")


def validate_runtime_home(home: dict[str, str]) -> dict[str, str]:
    """Check a `home` map (runtime name to interpreter location).

    Entries are allowed for any runtime, in either language, that
    resolves its interpreter or distribution from a location; only the
    selected runtime's entry is consumed, so one config stays portable
    across runtimes and languages.

    Args:
        home (dict[str, str]): runtime name to build directory,
            interpreter path, or distribution URL.

    Raises:
        ValueError: an entry for a runtime that embeds its interpreter,
            or an unknown runtime name.
    """
    for key in home:
        if key == MontyRuntime.name:
            raise ValueError(
                "runtime 'monty' embeds its interpreter and does not "
                "take a home entry")
        if key not in RUNTIME_HOME_KEYS:
            known = ", ".join(repr(k) for k in RUNTIME_HOME_KEYS)
            raise ValueError(f"unknown runtime name in home: {key!r} "
                             f"(expected one of {known})")
    return home


def select_python_runtime(name: str | None,
                          dispatch: Callable | None = None,
                          home: dict[str, str] | None = None) -> PythonRuntime:
    """Build the Python runtime for a workspace.

    Args:
        name (str | None): runtime name; None means the default (monty).
        dispatch (Callable | None): workspace dispatch the sandboxed
            runtime bridges file I/O through. Ignored by `wasi` and
            `local`, which never see workspace mounts.
        home (dict[str, str] | None): runtime name to interpreter
            location; the selected runtime consumes its own entry
            (`wasi`: CPython WASI build directory, falling back to
            MIRAGE_WASI_HOME; `local`: interpreter path, falling back
            to MIRAGE_LOCAL_HOME then the interpreter running mirage).
            Other entries are ignored.

    Raises:
        ValueError: unknown runtime name, or an invalid home entry.
    """
    resolved = validate_python_runtime_name(name or DEFAULT_PYTHON_RUNTIME)
    entries = validate_runtime_home(home or {})
    if resolved == MontyRuntime.name:
        return MontyRuntime(dispatch)
    if resolved == WasiRuntime.name:
        return WasiRuntime(home=entries.get(WasiRuntime.name))
    return LocalRuntime(home=entries.get(LocalRuntime.name))
