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

import ast
import importlib
import inspect
import pathlib

import mirage.core.gdrive.versions as versions_mod
import mirage.core.google.client as client_mod
import mirage.core.google.drive as drive_mod
from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.gdrive.api import DriveApi, DriveClient, drive_api

SOURCE = pathlib.Path(
    importlib.import_module("mirage").__file__).resolve().parent

# The three modules that speak to the Drive API over HTTP. Nothing in the
# gdrive backend may import a call from them by value: that is a second
# door beside the accessor's, and the one the #684 fake could not cover.
WIRE_MODULES = {
    "mirage.core.google.drive": drive_mod,
    "mirage.core.google.client": client_mod,
    "mirage.core.gdrive.versions": versions_mod,
}

# The seam's own two modules: `api.py` builds the door and `versions.py`
# is the Drive Revisions wire, the way `core/s3/client.py` is S3's.
SEAM_MODULES = {
    SOURCE / "core" / "gdrive" / "api.py",
    SOURCE / "core" / "gdrive" / "versions.py",
}

BACKEND_ROOTS = [
    SOURCE / "core" / "gdrive",
    SOURCE / "ops" / "gdrive",
    SOURCE / "commands" / "builtin" / "gdrive",
    SOURCE / "resource" / "gdrive",
]


def _backend_modules() -> list[pathlib.Path]:
    found = [SOURCE / "accessor" / "gdrive.py"]
    for root in BACKEND_ROOTS:
        found.extend(p for p in sorted(root.rglob("*.py")))
    return [p for p in found if p not in SEAM_MODULES]


def _wire_calls(module) -> set[str]:
    return {
        name
        for name, value in vars(module).items()
        if inspect.iscoroutinefunction(value)
    }


def _offending_imports(path: pathlib.Path) -> list[str]:
    tree = ast.parse(path.read_text())
    offences: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in WIRE_MODULES:
                    offences.append(f"import {alias.name}")
        elif isinstance(node, ast.ImportFrom):
            module = WIRE_MODULES.get(node.module or "")
            if module is None:
                continue
            calls = _wire_calls(module)
            for alias in node.names:
                if alias.name in calls:
                    offences.append(f"from {node.module} import {alias.name}")
    return offences


def test_every_gdrive_module_reaches_drive_through_the_one_seam():
    """No gdrive module imports a Drive call by value.

    #684: the e2e fake patched ``list_files`` where readdir had bound it,
    so ``find`` -- which reaches Drive through resolve and tree -- ran
    against the live API mid-test. A by-value import is a door the fake
    cannot see, and this fails the moment a new one appears.
    """
    offenders = {
        str(path.relative_to(SOURCE)): offences
        for path in _backend_modules()
        if (offences := _offending_imports(path))
    }
    assert not offenders, (
        f"these modules bypass GDriveAccessor.drive: {offenders}. Add the "
        "call to DriveApi in core/gdrive/api.py and reach it through "
        "accessor.drive instead.")


def test_drive_api_builds_a_client_over_the_token_manager():
    accessor_token = object()
    client = drive_api(accessor_token)
    assert isinstance(client, DriveClient)
    assert client.token_manager is accessor_token


def test_drive_client_answers_every_call_the_protocol_declares():
    declared = {
        name
        for name in vars(DriveApi)
        if not name.startswith("_") and callable(getattr(DriveApi, name))
    }
    assert declared
    missing = [
        name for name in declared
        if not inspect.iscoroutinefunction(getattr(DriveClient, name, None))
    ]
    assert not missing, f"DriveClient does not implement {missing}"


def test_the_accessor_builds_a_fresh_door_per_read():
    """A cached door would freeze the live client onto the accessor.

    The resource constructs its accessor before a test installs a fake,
    so a door built once in ``__init__`` would already point at the real
    API by the time the fake arrives.
    """
    accessor = GDriveAccessor(config=None, token_manager=None)
    assert accessor.drive is not accessor.drive
