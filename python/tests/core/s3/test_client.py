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

from mirage.core.s3.client import is_condition_lost
from tests.core.s3.conftest import LOST_CODES, client_error

_CASES = LOST_CODES["cases"]


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_only_a_lost_condition_reads_as_lost(case):
    exc = client_error(case["code"], case["status"], "PutObject")
    assert is_condition_lost(exc) is case["lost"]


def test_a_transport_failure_is_not_a_lost_condition():
    assert not is_condition_lost(ConnectionError("reset by peer"))
