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

import json
from pathlib import Path

from mirage.core.s3.constants import (
    CONDITION_SUPPORT,
    CUSTOM_CONDITION_SUPPORT,
)

_FIXTURES = Path(__file__).parents[4] / "integ" / "fixtures" / "write"
_CONDITIONS = json.loads((_FIXTURES / "conditions.json").read_text())


def test_s3_put_modes_are_declared_for_default_and_custom_endpoints():
    assert CONDITION_SUPPORT["put"] == frozenset({"absent", "match"})
    assert CUSTOM_CONDITION_SUPPORT == {"put": CONDITION_SUPPORT["put"]}
