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
from mirage.commands.config import RegisteredCommand

# The families whose generics merge namespace symlinks (ls/stat/find/
# du/file read `opts.ns.links`). Since CommandOpts carries the fact into
# every handler, link awareness is inherited by delegating to the
# family generic — so the invariant worth pinning is the delegation
# itself: a bespoke wrapper that walks its own tree cannot see a link,
# still runs, still exits 0, and nothing notices until someone makes a
# link on that backend.
LINK_AWARE = ("ls", "stat", "find", "du", "file")

# The two spellings of delegation: the family's full-command generic
# entry, or find's walk primitives for the wrappers with custom guards
# (email pushes a folder-level -name down to IMAP search, github_ci
# refuses cross-run walks) that still route filtering through the
# shared walk.
GENERIC_CALLS = {
    "ls": ("ls_generic(", ),
    "stat": ("stat_generic(", "generic_stat("),
    "find": ("find_generic(", "find_walk_generic(", "resolve_start("),
    "du": ("du_generic(", ),
    "file": ("file_generic(", ),
}


def _registered() -> tuple[list[RegisteredCommand], list[str]]:
    """Every registered builtin command, plus modules that would not import.

    The failures are returned rather than skipped for the reason
    ``scripts/gen_specs.py`` states: a module that will not import
    registers nothing, so a command missing its delegation would pass
    this check by being absent rather than by being correct.
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


def test_link_aware_generics_read_the_links_field():
    """The family generics consume ``opts.ns.links``; deleting the read
    is how link support silently dies, so the read itself is pinned."""
    for name in LINK_AWARE:
        module = importlib.import_module(
            f"mirage.commands.builtin.generic.{name}")
        assert "opts.ns.links" in inspect.getsource(module), (
            f"generic {name} no longer reads opts.ns.links; symlinks are "
            "invisible to the whole family")


def test_every_link_aware_shadow_delegates_to_the_generic():
    """A bespoke command in a link-aware family must route through it.

    ``CommandOpts`` hands every handler the namespace facts, but only
    the family generic interprets them; a wrapper that walks its own
    tree opts the whole backend out of symlinks without failing
    anything. Mirrors the TS state, where every bespoke find/ls routes
    through the generic (``findGeneric``/``walkFind``).
    """
    commands, failed = _registered()
    assert not failed, f"builtin modules would not import: {failed}"
    offenders = []
    for cmd in commands:
        if cmd.name not in LINK_AWARE:
            continue
        fn = inspect.unwrap(cmd.fn)
        source_file = inspect.getsourcefile(fn) or ""
        if "/generic_bind/" in source_file:
            continue
        source = inspect.getsource(inspect.getmodule(fn))
        if not any(call in source for call in GENERIC_CALLS[cmd.name]):
            offenders.append(f"{cmd.resource}/{cmd.name} ({source_file})")
    assert not offenders, (
        "these commands shadow a link-aware family without delegating to "
        f"its generic, so symlinks are invisible to them: {offenders}")
