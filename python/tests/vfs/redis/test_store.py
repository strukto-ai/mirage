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
import importlib.abc
import importlib.machinery
import sys
from collections.abc import Sequence
from types import ModuleType

import pytest


class Uninstalled(importlib.abc.MetaPathFinder):
    def __init__(self, package: str) -> None:
        self.package = package

    def find_spec(
        self,
        fullname: str,
        path: Sequence[str] | None,
        target: ModuleType | None = None,
    ) -> importlib.machinery.ModuleSpec | None:
        if fullname == self.package:
            raise ModuleNotFoundError(
                f"No module named {fullname!r}", name=fullname
            )
        return None


@pytest.mark.parametrize(
    "missing, hinted", [("redis", True), ("redis.asyncio", False)]
)
def test_only_a_missing_redis_names_the_extra(monkeypatch, missing, hinted):
    for loaded in [m for m in sys.modules if m.split(".")[0] == "redis"]:
        monkeypatch.delitem(sys.modules, loaded)
    monkeypatch.delitem(sys.modules, "mirage.vfs.redis.store", raising=False)
    monkeypatch.setattr(
        sys, "meta_path", [Uninstalled(missing), *sys.meta_path]
    )
    with pytest.raises(ImportError) as raised:
        importlib.import_module("mirage.vfs.redis.store")
    assert (
        str(raised.value).startswith("RedisStore requires the 'redis' extra.")
        is hinted
    )
