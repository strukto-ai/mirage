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

from typing import Any, Callable

from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.python.local import LocalRuntime
from mirage.runtime.python.monty import MontyRuntime
from mirage.runtime.python.wasi import WasiRuntime

DEFAULT_PYTHON_RUNTIME = MontyRuntime.name

PYTHON_RUNTIMES = (MontyRuntime.name, WasiRuntime.name, LocalRuntime.name)

# The TypeScript-only runtime's name; it has no Python class to take
# `.name` from, but cross-language configs may carry its option block.
PYODIDE_RUNTIME = "pyodide"

# Option keys each runtime (either language) accepts in its yaml block
# / runtime_options entry. `home` locates the interpreter or
# distribution (JAVA_HOME-style); monty embeds its interpreter and has
# no options yet.
RUNTIME_OPTION_KEYS: dict[str, tuple[str, ...]] = {
    MontyRuntime.name: (),
    WasiRuntime.name: ("home", ),
    LocalRuntime.name: ("home", ),
    PYODIDE_RUNTIME: ("home", ),
}


def validate_python_runtime_name(name: str) -> str:
    """Check a runtime name, with a cross-language hint for TS names.

    Args:
        name (str): runtime name from config or the Workspace kwarg.

    Raises:
        ValueError: unknown runtime name.
    """
    if name in PYTHON_RUNTIMES:
        return name
    if name == PYODIDE_RUNTIME:
        raise ValueError(
            "python runtime 'pyodide' is TypeScript-only (a WASM CPython "
            "for runtimes without a host Python); Python supports 'monty' "
            "(sandboxed, default), 'wasi' (sandboxed full CPython), and "
            "'local' (the host CPython)")
    raise ValueError(f"unknown python runtime: {name!r} "
                     "(expected 'monty', 'wasi', or 'local')")


def validate_runtime_options(
        options: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Check per-runtime option blocks (runtime name to key/values).

    Blocks are allowed for any runtime in either language; only the
    selected runtime's block is consumed, so one config stays portable
    across runtimes and languages. Key validation of the selected
    block happens at selection, where the runtime is known.

    Args:
        options (dict[str, dict[str, Any]]): runtime name to option
            block, e.g. ``{"wasi": {"home": "/opt/cpython-wasi"}}``.

    Raises:
        ValueError: a block for an unknown runtime name.
    """
    for key in options:
        if key not in RUNTIME_OPTION_KEYS:
            known = ", ".join(repr(k) for k in RUNTIME_OPTION_KEYS)
            raise ValueError(f"unknown runtime name in runtime options: "
                             f"{key!r} (expected one of {known})")
    return options


def resolve_runtime_options(
        resolved: str,
        options: dict[str, dict[str, Any]] | None) -> dict[str, Any]:
    """Extract and key-check the selected runtime's option block.

    Args:
        resolved (str): the selected runtime name.
        options (dict[str, dict[str, Any]] | None): per-runtime option
            blocks; blocks for other runtimes are ignored.

    Raises:
        ValueError: an unknown runtime name, or an option key the
            selected runtime does not accept.
    """
    entries = validate_runtime_options(options or {})
    opts = dict(entries.get(resolved) or {})
    known = RUNTIME_OPTION_KEYS[resolved]
    unknown = sorted(k for k in opts if k not in known)
    if unknown:
        listed = ", ".join(repr(k) for k in unknown)
        accepts = (f"expected: {', '.join(repr(k) for k in known)}"
                   if known else f"the {resolved} runtime takes no options")
        raise ValueError(
            f"unknown {resolved} runtime option(s): {listed} ({accepts})")
    return opts


def select_python_runtime(
        name: str | None,
        dispatch: Callable | None = None,
        options: dict[str, dict[str, Any]] | None = None) -> PythonRuntime:
    """Build the Python runtime for a workspace.

    Args:
        name (str | None): runtime name; None means the default (monty).
        dispatch (Callable | None): workspace dispatch the sandboxed
            runtime bridges file I/O through. Ignored by `wasi` and
            `local`, which never see workspace mounts.
        options (dict[str, dict[str, Any]] | None): per-runtime option
            blocks; the selected runtime consumes its own block
            (`wasi`: `home` is the CPython WASI build directory,
            falling back to MIRAGE_WASI_HOME; `local`: `home` is the
            interpreter path, falling back to MIRAGE_LOCAL_HOME then
            the interpreter running mirage). Other blocks are ignored.

    Raises:
        ValueError: unknown runtime name, or an invalid option block.
    """
    resolved = validate_python_runtime_name(name or DEFAULT_PYTHON_RUNTIME)
    opts = resolve_runtime_options(resolved, options)
    if resolved == MontyRuntime.name:
        return MontyRuntime(dispatch)
    if resolved == WasiRuntime.name:
        return WasiRuntime(home=opts.get("home"))
    return LocalRuntime(home=opts.get("home"))
