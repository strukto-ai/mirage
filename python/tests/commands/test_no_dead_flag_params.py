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

import importlib
import inspect
import pkgutil
from typing import Any, Callable, Iterator

import mirage.commands
import mirage.commands.builtin.generic_bind.builders as builders_pkg
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import CommandSpec, spec_flag_names

# The context the dispatcher hands a handler, none of it a command-line
# flag. Everything except the leading positionals is set in
# `workspace/mount/mount.py::execute_cmd`; `stat_overlay`, `links` and
# `stat_path` reach only handlers that name them. `command`, `prefix` and
# `spec` are the provision call's own context
# (`workspace/provision/command.py`), `results` the aggregate's.
DISPATCHER_PARAMS = frozenset({
    "ops",
    "accessor",
    "paths",
    "texts",
    "results",
    "spec",
    "index",
    "cwd",
    "filetype_fns",
    "stdin",
    "dispatch",
    "session_id",
    "env",
    "exec_allowed",
    "runtime",
    "runtime_unavailable",
    "stat_overlay",
    "links",
    "stat_path",
    "mounts",
    "prefix",
    "command",
})


def _handlers() -> Iterator[tuple[str, str, CommandSpec, Callable[..., Any]]]:
    """Every registered command handler and generic-bind builder.

    Yields (command name, source label, spec, function) for the handler
    itself and for any provision/aggregate function registered with it.
    """
    seen: set[int] = set()
    for info in pkgutil.walk_packages(mirage.commands.__path__,
                                      prefix="mirage.commands."):
        module = importlib.import_module(info.name)
        for value in vars(module).values():
            if not callable(value):
                continue
            for rc in getattr(value, "_registered_commands", ()):
                if id(rc) in seen:
                    continue
                seen.add(id(rc))
                source = inspect.getsourcefile(inspect.unwrap(rc.fn)) or "?"
                label = source.split("/mirage/")[-1]
                yield rc.name, label, rc.spec, rc.fn
                for extra, kind in ((rc.provision_fn, "provision"),
                                    (rc.aggregate, "aggregate")):
                    if extra is not None:
                        yield rc.name, f"{label} [{kind}]", rc.spec, extra

    for info in pkgutil.iter_modules(builders_pkg.__path__):
        module = importlib.import_module(
            f"{builders_pkg.__name__}.{info.name}")
        builder = getattr(module, "BUILDER", None)
        spec = SPECS.get(getattr(builder, "name", ""))
        if builder is None or spec is None:
            continue
        yield builder.name, f"builders/{info.name}.py", spec, builder.fn


def test_handlers_declare_no_flag_the_parser_cannot_emit():
    """Named parameters are canonical dests, or dispatcher context.

    The parser maps every spelling of an option onto one canonical dest
    -- the long spelling whenever the option declares one -- so a
    parameter named after a short spelling that has a long twin can
    never be filled. It stays False forever while reading like live
    code, and the `x or fl.as_bool("long")` merge that usually
    accompanies it hides the fact. The same check catches a parameter
    the spec dropped entirely.
    """
    offenders = []
    for name, label, spec, fn in _handlers():
        allowed = spec_flag_names(spec) | DISPATCHER_PARAMS
        try:
            signature = inspect.signature(inspect.unwrap(fn))
        except (TypeError, ValueError):
            continue
        dead = [
            param for param, kind in signature.parameters.items()
            if kind.kind not in (kind.VAR_KEYWORD,
                                 kind.VAR_POSITIONAL) and param not in allowed
        ]
        if dead:
            offenders.append(f"{label}: {name}({', '.join(dead)})")
    assert not offenders, (
        "these parameters name a flag spelling the parser never emits "
        "(read the canonical dest through FlagView instead):\n" +
        "\n".join(sorted(set(offenders))))
