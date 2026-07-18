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

from mirage.runtime.js.base import JsRuntime
from mirage.runtime.js.quickjs import QuickJsRuntime
from mirage.runtime.options import resolve_runtime_options

DEFAULT_JS_RUNTIME = QuickJsRuntime.name

JS_RUNTIMES = (QuickJsRuntime.name, )


def validate_js_runtime_name(name: str) -> str:
    """Check a JavaScript runtime name.

    Args:
        name (str): runtime name from config or the Workspace kwarg.

    Raises:
        ValueError: unknown runtime name.
    """
    if name in JS_RUNTIMES:
        return name
    raise ValueError(f"unknown js runtime: {name!r} (expected 'quickjs')")


def select_js_runtime(
        name: str | None,
        dispatch: Callable[..., Any] | None = None,
        options: dict[str, dict[str, Any]] | None = None,
        mount_prefixes: Callable[[], list[str]] | None = None) -> JsRuntime:
    """Build the JavaScript runtime for a workspace.

    Args:
        name (str | None): runtime name; None means the default (quickjs).
        dispatch (Callable | None): workspace dispatch the sandboxed
            runtime bridges file I/O through.
        options (dict[str, dict[str, Any]] | None): per-runtime option
            blocks; the selected runtime consumes its own block
            (`quickjs`: `home` is the directory containing qjs-wasi.wasm,
            falling back to MIRAGE_QUICKJS_HOME). Other blocks are ignored.
        mount_prefixes (Callable[[], list[str]] | None): live list of
            workspace mount prefixes the runtime routes to the dispatch.

    Raises:
        ValueError: unknown runtime name, or an invalid option block.
    """
    resolved = validate_js_runtime_name(name or DEFAULT_JS_RUNTIME)
    opts = resolve_runtime_options(resolved, options)
    return QuickJsRuntime(home=opts.get("home"),
                          dispatch=dispatch,
                          mount_prefixes=mount_prefixes)
