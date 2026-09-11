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
import importlib.util
from typing import Any

# The module name a class loaded from a script file runs under. A snapshot
# records a resource's class as ``module.Class``, and this name is the one
# the loader cannot import back, so the snapshot loader keys on it to fall
# back to the ``resource:`` reference the registry built the class from.
SCRIPT_MODULE_NAME = "_mirage_user_backend"


def load_attr(spec: str) -> Any:
    """Load a module attribute from a reference string.

    Supports two formats (auto-detected):
    - Script file: ``"./my_backend.py:MyClass"``
    - Module dotpath: ``"mypackage.backends:MyClass"``

    Args:
        spec (str): ``"source:attr_name"`` where source is a file path
            or module dotpath.

    Returns:
        Any: The loaded attribute; callers type-check what they expect
        (a resource class, a CLISpec tree).
    """
    if ":" not in spec:
        raise ValueError(
            f"invalid backend spec {spec!r}, expected 'source:ClassName'")

    source, attr_name = spec.rsplit(":", 1)

    if "/" in source or source.endswith(".py"):
        module_spec = importlib.util.spec_from_file_location(
            SCRIPT_MODULE_NAME, source)
        if module_spec is None or module_spec.loader is None:
            raise ValueError(f"cannot load script {source!r}")
        module = importlib.util.module_from_spec(module_spec)
        try:
            module_spec.loader.exec_module(module)
        except FileNotFoundError:
            raise ValueError(f"cannot load script {source!r}")
    else:
        module = importlib.import_module(source)

    if not hasattr(module, attr_name):
        raise ValueError(f"{attr_name!r} not found in {source!r}")

    return getattr(module, attr_name)


def load_backend_class(spec: str) -> type[Any]:
    """Load a backend class from a spec string via :func:`load_attr`.

    Args:
        spec (str): ``"source:class_name"`` where source is a file path
            or module dotpath.

    Returns:
        type: The loaded class.
    """
    return load_attr(spec)
