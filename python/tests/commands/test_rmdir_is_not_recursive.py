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

import mirage.commands.builtin as builtin_pkg
from mirage.commands.builtin.generic_bind import CommandIO


def _origin(fn: object) -> tuple[str, str]:
    """Where a wired op's body was written.

    ``(module, qualname)`` rather than the object, so a closure built by
    calling one factory twice reports the one body it came from.
    """
    return (getattr(fn, "__module__", ""), getattr(fn, "__qualname__", ""))


def _command_ios() -> dict[str, CommandIO]:
    """Every backend's wired ``CommandIO``, keyed by backend package name."""
    found: dict[str, CommandIO] = {}
    for info in pkgutil.iter_modules(builtin_pkg.__path__):
        if not info.ispkg:
            continue
        try:
            module = importlib.import_module(
                f"{builtin_pkg.__name__}.{info.name}.io")
        except ModuleNotFoundError:
            continue
        io = getattr(module, "IO", None)
        if isinstance(io, CommandIO):
            found[info.name] = io
    return found


def test_every_backend_io_is_discovered():
    ios = _command_ios()
    # A guard on the guard: an import that silently stopped resolving would
    # make every assertion below vacuous.
    assert len(ios) > 20
    assert {"ram", "s3", "nextcloud", "gdrive", "onedrive"} <= set(ios)


def test_rmdir_is_never_the_recursive_removal():
    """``rmdir`` and ``rm -r`` must not be one function.

    rmdir(2) refuses a non-empty directory; ``rm -r`` is what empties one.
    Wiring both slots to the same callable silently turns ``rmdir`` into a
    subtree delete for every caller that does not pre-check emptiness
    itself, and the command builders are the only callers that do -- FUSE,
    ``ws.fs`` and the sandbox runtimes all reach the op directly. That is
    the shape the bug took in five backends at once: two shared the object
    store kit's prefix delete, three aliased the op outright.

    Sharing was never load-bearing, even on a keyed store where an empty
    directory is just its marker object: deleting the marker and deleting
    the prefix are only the same request while the directory is empty,
    which is exactly what rmdir cannot assume.

    Provenance is compared, not object identity, because identity misses
    the form the object store backends had: one factory called twice
    yields two distinct closures that run the same body, so ``is not``
    reads as two implementations where there is one.
    """
    shared = sorted(
        name for name, io in _command_ios().items()
        if io.rmdir is not None and _origin(io.rmdir) == _origin(io.rm_r))
    assert not shared, ("these backends wire rmdir to their recursive "
                        f"removal: {shared}")
