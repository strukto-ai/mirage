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

import pytest

from mirage.commands.builtin.generic.search import semantic_options
from mirage.commands.errors import UsageError
from mirage.commands.spec.flag_view import FlagView


def test_semantic_options_default_the_method_only_when_absent():
    assert semantic_options(FlagView({})) == {
        "method": "semantic",
        "threshold": 0.0,
    }
    with pytest.raises(UsageError, match="only the 'semantic' method"):
        semantic_options(FlagView({"method": ""}))
