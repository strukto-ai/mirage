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

from typing import Any

# Option keys each runtime (in either language) accepts in its yaml
# block / runtime_options entry. `home` locates the interpreter or
# distribution (JAVA_HOME-style); monty embeds its interpreter and has
# no options yet. The registry spans both languages so one config stays
# portable: `pyodide` is TypeScript-only, the rest are shared.
RUNTIME_OPTION_KEYS: dict[str, tuple[str, ...]] = {
    "monty": (),
    "wasi": ("home", ),
    "local": ("home", ),
    "pyodide": ("home", ),
    "quickjs": ("home", ),
}


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
