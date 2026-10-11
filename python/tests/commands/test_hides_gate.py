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

import mirage.commands.builtin as builtin
from mirage.commands.config import Command

# A native fast path answers from the raw backend tree, so every place
# one is wired must fork to the guarded walk when a hide, a path rule or
# a pre_vfs policy could judge an entry inside the subtree it answers
# for. The gate is `paths_scoped`, which reads the command's namespace
# view; this meta-test pins the fork wherever a native core is wired, so
# the next backend that ships one cannot silently list what a session
# hides.
GATE = "paths_scoped"


def _registered() -> tuple[list[Command], list[str]]:
    """Every registered builtin command, plus modules that would not
    import, mirrored from test_links_optin for the same reason: a
    module that will not import registers nothing, so a wrapper missing
    its gate would pass by being absent rather than by being correct.
    """
    found: list[Command] = []
    failed: list[str] = []
    seen: set[int] = set()
    for info in pkgutil.walk_packages(
        builtin.__path__, builtin.__name__ + "."
    ):
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


def test_the_chokepoints_read_the_gate():
    """The three shared fast-path forks consume the per-operand gate;
    deleting a read is how the guard silently dies, so each is pinned
    the way test_links_optin pins ``opts.ns.links``."""
    for module_name in (
        "mirage.commands.builtin.generic_bind.builders.find",
        "mirage.commands.builtin.generic_bind.search",
        "mirage.commands.builtin.generic.du",
    ):
        module = importlib.import_module(module_name)
        assert GATE in inspect.getsource(module), (
            f"{module_name} no longer consults {GATE}; its native fast "
            "path would answer for entries the session hides"
        )


def test_every_wired_find_core_forks_to_the_guarded_walk():
    """A bespoke find that passes ``find_core=`` classifies on the raw
    tree, so its module must hold the same fork the factory builder
    has: the gate plus ``find_walk_generic``. The generic's tail filter
    hides the names, but only the walk classifies correctly (-empty on
    a directory whose only child is hidden must still match)."""
    commands, failed = _registered()
    assert not failed, f"builtin modules would not import: {failed}"
    offenders = []
    for cmd in commands:
        if cmd.name != "find":
            continue
        fn = inspect.unwrap(cmd.fn)
        source_file = inspect.getsourcefile(fn) or ""
        if "/generic_bind/" in source_file:
            continue
        source = inspect.getsource(inspect.getmodule(fn))
        if "find_core=" not in source:
            continue
        if GATE not in source or "find_walk_generic" not in source:
            offenders.append(f"{cmd.vfs}/{cmd.name} ({source_file})")
    assert not offenders, (
        "these find wrappers wire a native core without forking to the "
        f"guarded walk under {GATE}: {offenders}"
    )


def test_no_backend_registers_its_own_grep_or_rg():
    """A mount's search is ``files_containing`` and ``lines_containing``,
    which only the generic's reads ask, behind the gate; a backend grep
    or rg would answer from the raw tree and print lines out of files
    the session cannot see."""
    commands, failed = _registered()
    assert not failed, f"builtin modules would not import: {failed}"
    offenders = [
        f"{cmd.vfs}/{cmd.name} ({inspect.getsourcefile(inspect.unwrap(cmd.fn))})"
        for cmd in commands
        if cmd.name in ("grep", "rg")
        and "/generic_bind/"
        not in (inspect.getsourcefile(inspect.unwrap(cmd.fn)) or "")
    ]
    assert not offenders, f"backend grep or rg wrappers: {offenders}"
