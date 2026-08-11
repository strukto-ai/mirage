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
import pkgutil

import mirage.commands.builtin as builtin
from mirage.commands.builtin.generic_bind.builders import _BUILDERS
from mirage.commands.config import RegisteredCommand
from mirage.utils.params import accepts_kwarg
from mirage.workspace.route.constants import (DEREFERENCE_FLAGS,
                                              LAST_WINS_LINK_OPTIONS)


def _link_flags(name: str) -> set[str]:
    """The link options a command takes, read off the router's own tables.

    Derived rather than listed so that teaching the router a new link
    option (GNU's ``-H``, say) also starts requiring it here, instead of
    leaving a flag every bespoke wrapper is free to drop.

    Args:
        name (str): command name.
    """
    shorts = set(DEREFERENCE_FLAGS.get(name, ("", ()))[0])
    leading = {opt.lstrip("-") for opt in LAST_WINS_LINK_OPTIONS.get(name, {})}
    return shorts | leading


# Facts the dispatcher offers that a command only receives by naming the
# parameter (the `offered` dict in mount.execute_cmd). `stat_overlay` is
# offered the same way and has the same gaps, but closing those is not a
# symlink or traversal change; see #688.
INJECTED_FACTS = ("links", "stat_path")


def _fact_aware() -> dict[str, set[str]]:
    """Command name to the injected parameters its generic builder takes.

    Two shapes are required: the dispatcher facts a generic reads
    (``links`` for namespace symlinks, ``stat_path`` for the start point
    a traversal command cannot stat through one backend), and the link
    options. A wrapper that names none of them still runs and still
    exits 0, it just answers as though no link existed and no start
    point could be resolved, so every side is required here.
    """
    return {
        b.name: ({f
                  for f in INJECTED_FACTS if accepts_kwarg(b.fn, f)}
                 | {f
                    for f in _link_flags(b.name) if accepts_kwarg(b.fn, f)})
        for b in _BUILDERS if any(
            accepts_kwarg(b.fn, f) for f in INJECTED_FACTS)
    }


def _registered() -> tuple[list[RegisteredCommand], list[str]]:
    """Every registered builtin command, plus modules that would not import.

    The failures are returned rather than skipped for the reason
    ``scripts/gen_specs.py`` states: a module that will not import
    registers nothing, so a command missing its opt-in would pass this
    check by being absent rather than by being correct.
    """
    found: list[RegisteredCommand] = []
    failed: list[str] = []
    seen: set[int] = set()
    for info in pkgutil.walk_packages(builtin.__path__,
                                      builtin.__name__ + "."):
        try:
            module = importlib.import_module(info.name)
        except ImportError as exc:
            failed.append(f"{info.name}: {exc}")
            continue
        for value in vars(module).values():
            cmds = getattr(value, "_registered_commands", None)
            if cmds is None or id(value) in seen:
                continue
            seen.add(id(value))
            found.extend(cmds)
    return found, failed


def test_every_link_aware_command_accepts_links():
    """A bespoke command may not silently opt out of symlink support.

    Symlinks live in the namespace, so a command only sees them when the
    dispatcher hands it a LinkView, and it only gets one by naming a
    ``links`` parameter. A backend that ships its own `find`/`ls`/`du`/
    `stat`/`file` and forgets the parameter still runs, still exits 0,
    and simply cannot see a link. ``-L`` is the same shape: the flag is
    parsed for every command in the family, but a wrapper that does not
    name it drops it into its opaque flag bag and never dereferences.
    Both failures are invisible until someone makes a link on that
    backend, so they are asserted here instead.
    """
    fact_aware = _fact_aware()
    assert fact_aware, "no fact-aware builders found: the derivation broke"
    commands, failed = _registered()
    assert not failed, f"builtin modules would not import: {failed}"
    missing = sorted({
        f"{cmd.resource}/{cmd.name} is missing {sorted(gap)}"
        for cmd in commands
        for gap in [{
            p
            for p in fact_aware.get(cmd.name, ())
            if not accepts_kwarg(cmd.fn, p)
        }] if gap
    })
    assert not missing, (
        "these commands shadow a generic without accepting the dispatcher "
        "facts it reads, so symlinks are invisible to them and a start "
        f"point cannot be resolved: {missing}")
