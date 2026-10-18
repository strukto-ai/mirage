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

from importlib import import_module
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from mirage.io.async_line_iterator import (
        AsyncLineIterator as AsyncLineIterator,
    )
    from mirage.io.types import IOResult as IOResult
    from mirage.io.types import OpReport as OpReport

_EXPORTS = {
    "AsyncLineIterator": "mirage.io.async_line_iterator",
    "IOResult": "mirage.io.types",
    "OpReport": "mirage.io.types",
}
__all__ = list(_EXPORTS)


def __getattr__(name: str) -> Any:
    if name not in _EXPORTS:
        raise AttributeError(name)
    value = getattr(import_module(_EXPORTS[name]), name)
    globals()[name] = value
    return value
