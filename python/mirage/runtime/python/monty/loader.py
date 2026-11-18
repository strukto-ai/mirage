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

from types import ModuleType
from typing import Any

from mirage.runtime.python.monty.constants import MISSING_PACKAGE_HINT
from mirage.runtime.python.monty.errors import MontyUnavailableError

_pydantic_monty: ModuleType | None
AbstractOS: Any
path_from_arg: Any
try:
    import pydantic_monty as _package
except ModuleNotFoundError as exc:
    if exc.name != "pydantic_monty":
        raise
    _pydantic_monty = None
    AbstractOS = object
    path_from_arg = None
else:
    from pydantic_monty.os_access import path_from_arg as _path_from_arg

    _pydantic_monty = _package
    AbstractOS = _package.AbstractOS
    path_from_arg = _path_from_arg


def load_monty_module() -> ModuleType:
    """The installed engine, or the install hint for the optional runtime."""
    if _pydantic_monty is None:
        raise MontyUnavailableError(MISSING_PACKAGE_HINT)
    return _pydantic_monty
