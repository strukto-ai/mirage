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

import os
import re
from pathlib import Path

from mirage.server.env import ENV_HOME, ENV_PID_FILE

_SAFE_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def _absolute(value: str | Path) -> Path:
    return Path(os.path.abspath(value))


def mirage_home() -> Path:
    """Resolve the base directory backing the ``.mirage`` data tree.

    Priority: ``$MIRAGE_HOME`` if set, else ``~/.mirage``. A relative
    override is absolutized against the current working directory so
    the daemon and later CLI invocations agree on one location.

    Returns:
        Path: absolute base directory for the pid file, log file,
            auth token, config, repos, and snapshots.
    """
    override = os.environ.get(ENV_HOME)
    return _absolute(override) if override else Path.home() / ".mirage"


def pid_file_path(explicit: str | Path | None = None) -> Path:
    """Resolve the daemon pid file location.

    Priority: ``explicit`` argument, then ``$MIRAGE_PID_FILE``, then
    ``daemon.pid`` under :func:`mirage_home`. Relative values are
    absolutized against the current working directory.

    Args:
        explicit (str | Path | None): caller-supplied override that
            wins over any environment variable.

    Returns:
        Path: the resolved absolute pid file path.
    """
    if explicit is not None:
        return _absolute(explicit)
    override = os.environ.get(ENV_PID_FILE)
    return _absolute(override) if override else mirage_home() / "daemon.pid"


def default_version_root() -> Path:
    """Default git repos root, under :func:`mirage_home`."""
    return mirage_home() / "repos"


def default_snapshot_root() -> Path:
    """Default snapshot root, under :func:`mirage_home`."""
    return mirage_home() / "snapshots"


class PathOutsideRootError(Exception):
    pass


def resolve_within_root(root: str | Path, user_path: str) -> Path:
    """Resolve user_path against root and assert it stays within root.

    Args:
        root (str | Path): the trusted directory paths are confined to.
        user_path (str): a request-supplied path, relative or absolute.

    Returns:
        Path: the resolved absolute path, guaranteed to be root itself
            or a descendant of root.
    """
    resolved_root = os.path.realpath(str(root))
    resolved = os.path.realpath(os.path.join(resolved_root, user_path))
    if os.path.commonpath([resolved_root, resolved]) != resolved_root:
        raise PathOutsideRootError(
            f"path escapes the configured root: {user_path}")
    return Path(resolved)


def validate_path_segment(segment: str) -> str:
    """Assert segment is a single safe path component.

    Args:
        segment (str): a request-supplied identifier used as one path
            component (no separators, not . or ..).

    Returns:
        str: the validated segment.
    """
    if segment in (".", "..") or _SAFE_SEGMENT_RE.match(segment) is None:
        raise PathOutsideRootError(f"invalid path segment: {segment}")
    return segment
