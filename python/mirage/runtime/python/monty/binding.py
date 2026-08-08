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

# pydantic-monty is the `monty` extra, so importing this package must
# not require it: every name below resolves to None when it is absent
# and the runtime raises a pointed ImportError at construction instead.
# OSAccess falls back to `object` because a class statement subclasses
# it at import time, before any of that can be checked.
pydantic_monty: Any
MemoryFile: Any
MontyFileHandle: Any
OSAccess: Any
path_from_arg: Any
try:
    import pydantic_monty as _pydantic_monty
    from pydantic_monty import MemoryFile as _MemoryFile
    from pydantic_monty import MontyFileHandle as _MontyFileHandle
    from pydantic_monty import OSAccess as _OSAccess
    from pydantic_monty.os_access import path_from_arg as _path_from_arg
except ImportError:
    pydantic_monty = None
    MemoryFile = None
    MontyFileHandle = None
    OSAccess = object
    path_from_arg = None
else:
    pydantic_monty = _pydantic_monty
    MemoryFile = _MemoryFile
    MontyFileHandle = _MontyFileHandle
    OSAccess = _OSAccess
    path_from_arg = _path_from_arg
