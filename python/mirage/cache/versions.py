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

from weakref import WeakKeyDictionary

from mirage.observe.record import (
    CONTENT_CHANGING_OPS,
    RETRACT_FINGERPRINT_OPS,
    STAMP_FINGERPRINT_OPS,
    SUBTREE_RETRACT_OPS,
    OpRecord,
)
from mirage.utils.key_prefix import under_path


class VersionScope:
    """Identity of one live mount; never persisted."""

    def __init__(self) -> None:
        self.pins: dict[str, str] = {}


class VersionHistory:
    """A live session's observations, independent of shared cache eviction."""

    def __init__(self) -> None:
        self._scopes: WeakKeyDictionary[
            VersionScope, dict[str, tuple[OpRecord, str | None] | str | None]
        ] = WeakKeyDictionary()

    def read(self, scope: VersionScope, key: str) -> str | None:
        """Return the token observed for this mount-relative key.

        Args:
            scope (VersionScope): live VFS identity.
            key (str): resolved mount-relative file name.
        """
        held = self._scopes.get(scope, {}).get(key, scope.pins.get(key))
        if not isinstance(held, tuple):
            return held
        rec, previous = held
        if rec.op == "read" and not rec.complete and rec.bytes == 0:
            return previous
        return rec.fingerprint

    def keep(self, scope: VersionScope, key: str, version: str | None) -> None:
        """Retain a refused condition until this session reads again.

        Args:
            scope (VersionScope): live VFS identity.
            key (str): resolved mount-relative file name.
            version (str | None): the refused token, or None when gone.
        """
        self._scopes.setdefault(scope, {})[key] = version

    def observe(self, scope: VersionScope, key: str, rec: OpRecord) -> None:
        """Keep the exact record, including a stream's later token stamp.

        Args:
            scope (VersionScope): live VFS identity.
            key (str): resolved mount-relative file name.
            rec (OpRecord): the operation's own result.
        """
        if rec.op not in (
            STAMP_FINGERPRINT_OPS
            | RETRACT_FINGERPRINT_OPS
            | CONTENT_CHANGING_OPS
        ):
            return
        held = self._scopes.setdefault(scope, {})
        if rec.op in SUBTREE_RETRACT_OPS:
            for name in set(held) | set(scope.pins):
                if under_path(name, key):
                    held[name] = None
        if rec.op in STAMP_FINGERPRINT_OPS:
            # Headers alone are no observation: retain the prior condition
            # until bytes arrive or the stream ends normally.
            held[key] = (rec, self.read(scope, key))
        else:
            held[key] = None
