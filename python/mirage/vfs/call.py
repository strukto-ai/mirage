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

from collections.abc import Callable, Collection, Mapping
from typing import Any, TypeVar

from mirage.vfs.types import Declaration, Effect, Target

Fn = TypeVar("Fn", bound=Callable[..., Any])

_MARK = "__vfs_call__"


def vfs_call(
    *, effect: Effect, target: Target = Target.ANY, creates: bool = False
) -> Callable[[Fn], Fn]:
    """Make a VFS method callable by name through the dispatcher.

    ``ws.dispatch("search_abc", path, ...)`` reaches a method marked here
    through every check the door runs: hidden paths, path rules, the
    mount's mode and admission policies. The effect tells the door what
    the call does to the mount, so a read-only mount refuses a write and
    a policy judges it as one. A subclass overriding a marked method
    keeps the mark, so a backend writes its ``read`` without repeating it.

    The built-in functions' marks are where the door's op classes come
    from: which ops follow a link, create a name, run one at a time per
    path or stamp an mtime is read off what they declare here. Only
    ``rename`` declares RENAME: the door moves the hides, links and
    cache below a source to a destination, and only ``rename(path, dst)``
    names both.

    Args:
        effect (Effect): what the call does to the mount.
        target (Target): the kind of entry its path names.
        creates (bool): a WRITE that makes a missing file, as open(2)
            with O_CREAT.
    """

    def mark(fn: Fn) -> Fn:
        if effect is Effect.RENAME and fn.__name__ != "rename":
            raise TypeError(f"{fn.__name__}: only rename declares RENAME")
        setattr(fn, _MARK, Declaration(effect, target, creates))
        return fn

    return mark


def declared(cls: type, name: str) -> Declaration | None:
    """What ``cls`` declares for ``name``, None when not dispatchable.

    The first class in the method resolution order that marks ``name``
    answers, so an unmarked override inherits its base's mark.

    Args:
        cls (type): the VFS class.
        name (str): the function name.
    """
    for klass in cls.__mro__:
        mark = getattr(klass.__dict__.get(name), _MARK, None)
        if isinstance(mark, Declaration):
            return mark
    return None


def declared_calls(cls: type) -> dict[str, Declaration]:
    """Every name ``cls`` marks dispatchable, to what it declares.

    Args:
        cls (type): the VFS class.
    """
    names = sorted({name for klass in cls.__mro__ for name in vars(klass)})
    found = {name: declared(cls, name) for name in names}
    return {name: mark for name, mark in found.items() if mark is not None}


def call_names(
    calls: Mapping[str, Declaration],
    *,
    effects: Collection[Effect] = tuple(Effect),
    targets: Collection[Target] = tuple(Target),
    creates: bool | None = None,
) -> frozenset[str]:
    """The names in ``calls`` whose declaration matches every filter.

    Args:
        calls (Mapping[str, Declaration]): names to what they declare.
        effects (Collection[Effect]): the effects to keep.
        targets (Collection[Target]): the targets to keep.
        creates (bool | None): keep only creating (True) or only
            non-creating (False) calls; None keeps both.
    """
    return frozenset(
        name
        for name, mark in calls.items()
        if mark.effect in effects
        and mark.target in targets
        and (creates is None or mark.creates is creates)
    )
