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
import logging
from types import ModuleType

_logger = logging.getLogger(__name__)

_EXT_GROUPS = (
    ((".parquet", ), "parquet"),
    ((".orc", ), "orc"),
    ((".feather", ".arrow", ".ipc"), "feather"),
    ((".hdf5", ".h5"), "hdf5"),
)


def _load_modules() -> dict[str, ModuleType]:
    modules: dict[str, ModuleType] = {}
    for exts, name in _EXT_GROUPS:
        try:
            mod = importlib.import_module(f"mirage.core.filetype.{name}")
        except ImportError as e:
            _logger.debug("filetype module %s skipped: %s", name, e)
            continue
        for ext in exts:
            modules[ext] = mod
    return modules


_EXT_MODULES = _load_modules()


def _fmt(module: ModuleType) -> str:
    return module.__name__.rsplit(".", 1)[-1]
