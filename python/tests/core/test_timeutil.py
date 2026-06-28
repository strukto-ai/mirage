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

from datetime import datetime, timedelta, timezone

from mirage.core.timeutil import epoch_to_iso, now_iso, to_iso_z


def test_to_iso_z_converts_utc_offset_to_z():
    dt = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
    assert to_iso_z(dt) == "2026-01-02T03:04:05Z"


def test_to_iso_z_normalizes_non_utc_to_z():
    tz = timezone(timedelta(hours=5))
    dt = datetime(2026, 1, 2, 8, 4, 5, tzinfo=tz)
    assert to_iso_z(dt) == "2026-01-02T03:04:05Z"


def test_now_iso_uses_z_suffix():
    s = now_iso()
    assert s.endswith("Z")
    assert "+00:00" not in s


def test_epoch_to_iso_whole_second():
    assert epoch_to_iso(1609459200) == "2021-01-01T00:00:00Z"


def test_epoch_to_iso_truncates_sub_second():
    assert epoch_to_iso(1609459200.987) == "2021-01-01T00:00:00Z"
