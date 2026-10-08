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

from collections.abc import Callable
from typing import Any, TypeVar

from mirage.vfs.types import Effect

Fn = TypeVar("Fn", bound=Callable[..., Any])

_EFFECT = "__vfs_effect__"


def vfs_call(*, effect: Effect) -> Callable[[Fn], Fn]:
    """Make a VFS method callable by name through the dispatcher.

    ``ws.dispatch("search_abc", path, ...)`` reaches a method marked here
    through every check the door runs: hidden paths, path rules, the
    mount's mode and admission policies. The effect tells the door what
    the call does to the mount, so a read-only mount refuses a write and
    a policy judges it as one. A subclass overriding a marked method
    keeps the mark, so a backend writes its ``read`` without repeating it.

    Args:
        effect (Effect): what the call does to the mount.
    """

    def mark(fn: Fn) -> Fn:
        setattr(fn, _EFFECT, effect)
        return fn

    return mark


def call_effect(cls: type, name: str) -> Effect | None:
    """The effect ``cls`` declares for ``name``, None when not dispatchable.

    The first class in the method resolution order that marks ``name``
    answers, so an unmarked override inherits its base's mark.

    Args:
        cls (type): the VFS class.
        name (str): the function name.
    """
    for klass in cls.__mro__:
        fn = klass.__dict__.get(name)
        effect = getattr(fn, _EFFECT, None)
        if isinstance(effect, Effect):
            return effect
    return None
