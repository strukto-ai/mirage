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

from mirage.cache.types import Measured


class ConditionLostError(Exception):
    """A conditional request the store refused: the object changed since
    the version sent, so the write did not land.

    Args:
        keys (list[str]): the raw keys whose condition did not hold, in
            the order they were met.
        landed (bool): a move's copy landed and only its source's delete
            lost, so the destination holds the copy.
        gone (bool): the object no longer exists, so no newer bytes are
            there for a retry to overwrite.
        versions (dict[str, Measured] | None): the version each lost key
            was measured on, where the op knew it; ABSENT for one found
            gone, which keeps none.
        error (Exception | None): a later failure that stopped a walk
            after these keys were lost; the caller keeps their versions
            and raises it.
    """

    def __init__(
        self,
        keys: list[str],
        landed: bool = False,
        gone: bool = False,
        versions: dict[str, Measured] | None = None,
        error: Exception | None = None,
    ) -> None:
        super().__init__(f"condition lost on {keys[0] if keys else ''!r}")
        self.keys = keys
        self.landed = landed
        self.gone = gone
        self.versions = versions or {}
        self.error = error
