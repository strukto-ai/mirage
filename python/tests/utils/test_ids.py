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

import time
import uuid

from mirage.utils.ids import new_session_id, new_workspace_id, uuid7


def test_uuid7_is_canonical_and_version_7():
    value = uuid7()
    parsed = uuid.UUID(value)
    assert value == str(parsed)
    assert value == value.lower()
    assert parsed.version == 7
    assert parsed.variant == uuid.RFC_4122


def test_uuid7_embeds_current_timestamp():
    # uuid6 smooths its clock for monotonicity, so allow a little skew.
    before_ms = time.time_ns() // 1_000_000
    parsed = uuid.UUID(uuid7())
    after_ms = time.time_ns() // 1_000_000
    embedded_ms = parsed.int >> 80
    assert before_ms - 10 <= embedded_ms <= after_ms + 10


def test_uuid7_orders_across_milliseconds():
    first = uuid7()
    time.sleep(0.002)
    second = uuid7()
    assert first < second


def test_uuid7_unique():
    values = {uuid7() for _ in range(1000)}
    assert len(values) == 1000


def test_id_kinds_share_the_format():
    assert uuid.UUID(new_workspace_id()).version == 7
    assert uuid.UUID(new_session_id()).version == 7
