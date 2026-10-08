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

from mirage.vfs.base import BaseVFS
from mirage.vfs.registry import REGISTRY, resolve_class


def _origin(fn: Any) -> tuple[str, str]:
    """Where a function's body was written.

    ``(module, qualname)`` rather than the object, so a closure built by
    calling one factory twice reports the one body it came from.
    """
    return (getattr(fn, "__module__", ""), getattr(fn, "__qualname__", ""))


def _callee(cls: type[BaseVFS], name: str) -> tuple[str, str] | None:
    """The function a VFS's ``name`` method hands its work to.

    A builtin's method calls one backend function by a module-level name;
    the first such name the method's code reads is that function.
    """
    method = cls.__dict__.get(name)
    if method is None:
        for klass in cls.__mro__[1:]:
            if klass is BaseVFS:
                return None
            method = klass.__dict__.get(name)
            if method is not None:
                break
    if method is None:
        return None
    for global_name in method.__code__.co_names:
        target = method.__globals__.get(global_name)
        if callable(target) and not isinstance(target, type):
            return _origin(target)
    return None


def _vfs_classes() -> dict[str, type[BaseVFS]]:
    """Every builtin VFS class, keyed by registry name."""
    return {
        name: resolve_class(entry.vfs_path) for name, entry in REGISTRY.items()
    }


def test_every_builtin_vfs_is_discovered():
    classes = _vfs_classes()
    # A guard on the guard: a lookup that silently stopped resolving would
    # make the assertion below vacuous.
    assert len(classes) > 20
    assert {"ram", "s3", "nextcloud", "gdrive", "onedrive"} <= set(classes)


def test_rmdir_is_never_the_recursive_removal():
    """``rmdir`` and ``rm -r`` must not be one function.

    rmdir(2) refuses a non-empty directory; ``rm -r`` is what empties one.
    Wiring both slots to the same callable silently turns ``rmdir`` into a
    subtree delete for every caller that does not pre-check emptiness
    itself, and the command builders are the only callers that do -- FUSE,
    ``ws.vfs`` and the sandbox runtimes all reach the op directly. That is
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
        name
        for name, cls in _vfs_classes().items()
        if (removal := _callee(cls, "rmdir")) is not None
        and removal == _callee(cls, "rm_r")
    )
    assert not shared, (
        f"these backends wire rmdir to their recursive removal: {shared}"
    )
