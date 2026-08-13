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
from mirage.commands.spec.types import CommandSpec

# The dispatcher calls every handler with exactly four positional
# arguments (`Mount.execute_cmd`), and the provision path with the same
# four (`handle_command_provision`); everything else -- flags, stdin,
# cwd, the namespace facts -- rides the CommandOpts bag. A handler that
# names anything else in its signature can never receive it.
HANDLER_PARAMS = ("accessor", "paths", "texts", "opts")
BUILDER_PARAMS = ("ops", ) + HANDLER_PARAMS
AGGREGATE_PARAMS = ("results", )


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
                if rc.provision_fn is not None:
                    yield rc.name, f"{label} [provision]", rc.spec, \
                        rc.provision_fn
                if rc.aggregate is not None:
                    yield rc.name, f"{label} [aggregate]", rc.spec, \
                        rc.aggregate

    for info in pkgutil.iter_modules(builders_pkg.__path__):
        module = importlib.import_module(
            f"{builders_pkg.__name__}.{info.name}")
        builder = getattr(module, "BUILDER", None)
        spec = SPECS.get(getattr(builder, "name", ""))
        if builder is None or spec is None:
            continue
        yield builder.name, f"builders/{info.name}.py", spec, builder.fn


def _param_names(fn: Callable[..., Any]) -> tuple[str, ...] | None:
    try:
        signature = inspect.signature(inspect.unwrap(fn))
    except (TypeError, ValueError):
        return None
    return tuple(signature.parameters)


def test_handlers_take_accessor_paths_texts_opts():
    """Registered handlers and provisions have the one dispatcher shape.

    Flags, stdin, cwd, and the namespace facts all ride ``CommandOpts``;
    a parameter named after any of them is dead the moment the
    dispatcher stops passing keywords, so the signature itself is
    pinned. Builders carry a leading ``ops`` (the factory binds it);
    aggregates take the fan-in result list.
    """
    offenders = []
    for name, label, spec, fn in _handlers():
        params = _param_names(fn)
        if params is None:
            continue
        if label.startswith("builders/"):
            expected: tuple[tuple[str, ...], ...] = (BUILDER_PARAMS, )
        elif label.endswith("[aggregate]"):
            expected = (AGGREGATE_PARAMS, )
        else:
            expected = (HANDLER_PARAMS, )
        if params not in expected:
            offenders.append(f"{label}: {name}({', '.join(params)})")
    assert not offenders, (
        "handlers are called as fn(accessor, paths, texts, opts) — flags "
        "and dispatcher facts ride CommandOpts, so any other parameter "
        "is never filled:\n" + "\n".join(sorted(set(offenders))))
