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

# What a command in a link-aware family has to accept: the namespace
# facts themselves, and the flag that says to report the target instead
# of the link. Both are forwarded to the generic and nothing else reads
# them, so omitting either is invisible at the call site.
LINK_PARAMS = ("links", "L")


def _link_aware() -> dict[str, set[str]]:
    """Command name to the link parameters its generic builder takes.

    Derived from the builders rather than listed, so a family that gains
    or loses link awareness moves this on its own.
    """
    return {
        b.name: {p
                 for p in LINK_PARAMS if accepts_kwarg(b.fn, p)}
        for b in _BUILDERS if accepts_kwarg(b.fn, "links")
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
    link_aware = _link_aware()
    assert link_aware, "no link-aware builders found: the derivation broke"
    commands, failed = _registered()
    assert not failed, f"builtin modules would not import: {failed}"
    missing = sorted({
        f"{cmd.resource}/{cmd.name} is missing {sorted(gap)}"
        for cmd in commands
        for gap in [{
            p
            for p in link_aware.get(cmd.name, ())
            if not accepts_kwarg(cmd.fn, p)
        }] if gap
    })
    assert not missing, (
        "these commands shadow a link-aware generic without accepting its "
        f"link parameters, so symlinks are invisible to them: {missing}")
