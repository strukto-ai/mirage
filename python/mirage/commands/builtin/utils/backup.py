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

import re

from mirage.commands.errors import UsageError
from mirage.types import PathSpec, ReaddirFn
from mirage.utils.key_prefix import rekey

# GNU version-control names (each canonical control has a legacy alias).
BACKUP_CONTROLS = {
    "none": "none",
    "off": "none",
    "simple": "simple",
    "never": "simple",
    "existing": "existing",
    "nil": "existing",
    "numbered": "numbered",
    "t": "numbered",
}

DEFAULT_BACKUP_SUFFIX = "~"

_NUMBERED_SUFFIX = re.compile(r"^\.~(\d+)~$")


def backup_control(cmd_name: str, value: str | bool | None,
                   suffix: str | None) -> str | None:
    """Resolve ``-b``/``--backup[=CONTROL]``/``-S`` into a backup control.

    Deliberate divergence from GNU: the ``VERSION_CONTROL`` and
    ``SIMPLE_BACKUP_SUFFIX`` environment variables are not consulted;
    the default control is GNU's env-less default, ``existing``. A bare
    ``-S SUFFIX`` enables backups on its own, matching GNU 9.7.

    Args:
        cmd_name (str): Command name for the invalid-argument error.
        value (str | bool | None): Raw ``-b``/``--backup`` flag value —
            ``True`` for the bare spellings, a string for
            ``--backup=CONTROL``, and ``None``/``False`` when absent.
        suffix (str | None): Raw ``-S``/``--suffix`` value, or None.

    Returns:
        str | None: Canonical control (``none``/``simple``/``existing``/
        ``numbered``), or None when backups are not requested.
    """
    enabled = value is not None and value is not False
    if not enabled and suffix is None:
        return None
    if isinstance(value, str):
        control = BACKUP_CONTROLS.get(value)
        if control is None:
            raise UsageError(
                f"{cmd_name}: invalid argument '{value}' for 'backup type'\n"
                "Valid arguments are:\n"
                "  - 'none', 'off'\n"
                "  - 'simple', 'never'\n"
                "  - 'existing', 'nil'\n"
                "  - 'numbered', 't'\n"
                f"Try '{cmd_name} --help' for more information.", 1)
        return control
    return "existing"


def sibling_path(path: PathSpec, appended: str) -> PathSpec:
    """A path next to ``path`` whose name carries an appended suffix.

    Args:
        path (PathSpec): The path the suffix is appended to.
        appended (str): Text appended to the full name (e.g. ``~``).
    """
    virtual = path.virtual.rstrip("/") + appended
    return PathSpec.from_str_path(
        virtual, rekey(path.virtual, path.resource_path, virtual))


def parent_path(path: PathSpec) -> PathSpec:
    """The directory containing ``path`` on the same mount.

    Args:
        path (PathSpec): Any non-root path.
    """
    virtual = path.virtual.rstrip("/").rsplit("/", 1)[0] or "/"
    resource = path.resource_path.rstrip("/").rsplit("/", 1)[0] \
        if "/" in path.resource_path.rstrip("/") else ""
    return PathSpec.from_str_path(virtual, resource)


async def _numbered_versions(readdir: ReaddirFn | None,
                             target: PathSpec) -> list[int]:
    """Existing numbered-backup versions (``name.~N~``) next to a target.

    A listing failure propagates: reading it as "no numbered backups" would
    pick ``.~1~`` (or fall back to the simple suffix) and silently overwrite
    backup history that may exist, so the caller aborts the overwrite.

    Args:
        readdir (ReaddirFn | None): Lists a directory's full child paths;
            None reads as no numbered backups.
        target (PathSpec): The path about to be backed up.
    """
    if readdir is None:
        return []
    base = target.virtual.rstrip("/").rsplit("/", 1)[-1]
    children = await readdir(parent_path(target))
    versions: list[int] = []
    for child in children:
        name = child.rstrip("/").rsplit("/", 1)[-1]
        if not name.startswith(base):
            continue
        match = _NUMBERED_SUFFIX.match(name[len(base):])
        if match:
            versions.append(int(match.group(1)))
    return versions


async def backup_target(readdir: ReaddirFn | None, target: PathSpec,
                        control: str, suffix: str) -> PathSpec | None:
    """Pick the backup path for a target about to be overwritten.

    GNU naming: ``simple`` appends the suffix, ``numbered`` appends
    ``.~N~`` one past the highest existing version, and ``existing``
    stays numbered while any numbered backup exists and is simple
    otherwise.

    Args:
        readdir (ReaddirFn | None): Directory lister for the version scan.
        target (PathSpec): The destination being replaced.
        control (str): Canonical control from ``backup_control``.
        suffix (str): Simple-backup suffix (default ``~``).
    """
    if control == "none":
        return None
    if control == "simple":
        return sibling_path(target, suffix)
    versions = await _numbered_versions(readdir, target)
    if control == "numbered" or versions:
        return sibling_path(target, f".~{max(versions, default=0) + 1}~")
    return sibling_path(target, suffix)
