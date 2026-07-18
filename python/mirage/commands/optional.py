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
from typing import Any, Callable

_logger = logging.getLogger(__name__)


def try_load_command(module: str,
                     attr: str,
                     extra: str = "") -> Callable[..., Any] | None:
    """Import an optional format command; skip if its dep is missing.

    Returns the imported attribute on success, or None if the underlying
    optional package (e.g. pyarrow, h5py) is not installed. Used by the
    per-resource command-registry __init__.py files so the base text-mode
    command always loads, while format helpers (parquet, hdf5, etc.) are
    silently dropped when their extras aren't installed.

    Args:
        module (str): dotted module path containing the command.
        attr (str): attribute name to fetch from the module.
        extra (str): name of the missing extra to suggest in the debug log.

    Returns:
        Callable | None: the command callable, or None if its dep is missing.
    """
    try:
        mod = importlib.import_module(module)
    except ImportError as e:
        hint = f" (pip install mirage-ai[{extra}])" if extra else ""
        _logger.debug("optional command %s.%s skipped%s: %s", module, attr,
                      hint, e)
        return None
    return getattr(mod, attr)
