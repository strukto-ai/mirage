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

from collections.abc import Awaitable, Callable
from typing import Any

import mirage.accessor.gdrive as accessor_mod

DriveCall = Callable[..., Awaitable[Any]]


class StubDrive:
    """A ``DriveApi`` that answers only the calls a test armed.

    Reaching an unarmed method is #684 in miniature, so it fails here
    rather than falling through to the live Drive API.
    """

    def __init__(self, **methods: DriveCall) -> None:
        self._methods = methods

    def __getattr__(self, name: str) -> DriveCall:
        try:
            return self._methods[name]
        except KeyError:
            raise AssertionError(
                f"the test reached Drive.{name} without arming it") from None


def install_drive(monkeypatch, drive):
    """Install a ``DriveApi`` behind the accessor's one seam.

    One target, because ``GDriveAccessor.drive`` is the only door a
    gdrive core op reaches Drive through.

    Args:
        monkeypatch: pytest's monkeypatch fixture.
        drive: the ``DriveApi`` implementation to serve.
    """
    monkeypatch.setattr(accessor_mod, "drive_api", lambda _tm: drive)
    return drive
