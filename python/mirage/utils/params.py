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

import functools
import inspect
from collections.abc import Callable
from typing import Any


@functools.lru_cache(maxsize=None)
def accepts_kwarg(fn: Callable[..., Any], name: str) -> bool:
    """Whether ``fn`` declares ``name`` as its own keyword parameter.

    This is how the dispatcher decides which optional facts a command
    wants (``stat_overlay``, ``links``): the command's signature is the
    declaration, so a command opts in by naming the parameter and opts
    out by removing it. There is no registry to keep in step.

    A bare ``**kwargs`` does not count. Command wrappers use it as an
    opaque bag of command-line flags and forward it wholesale to their
    generic, so treating it as consent would pass the fact straight
    through to a generic that cannot accept it.

    Handlers are wrapped by ``functools.wraps`` (``--help`` support), so
    the signature seen here is the underlying command's.

    Args:
        fn (Callable): the handler about to be called.
        name (str): the keyword being offered.
    """
    parameter = inspect.signature(fn).parameters.get(name)
    return (parameter is not None
            and parameter.kind is not inspect.Parameter.VAR_KEYWORD)
