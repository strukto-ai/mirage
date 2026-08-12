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
import time
from datetime import datetime, timezone
from stat import S_IFDIR, S_IFREG

import pytest

from mirage.types import FileStat, FileType
from mirage.utils.stat_view import (DIR_MODE, FILE_MODE, content_size, is_dir,
                                    mtime_ns)

NAIVE = "2026-01-02T03:04:05"
UTC_NS = int(
    datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc).timestamp() *
    1_000_000_000)


@pytest.fixture
def new_york_clock():
    # Force a non-UTC host zone so a translator that reads an
    # offset-less stamp as LOCAL time is off by hours instead of
    # passing by accident on a UTC CI runner.
    if not hasattr(time, "tzset"):
        pytest.skip("tzset unavailable on this platform")
    previous = os.environ.get("TZ")
    os.environ["TZ"] = "America/New_York"
    time.tzset()
    yield
    if previous is None:
        os.environ.pop("TZ", None)
    else:
        os.environ["TZ"] = previous
    time.tzset()


def test_offsetless_stamp_reads_as_utc(new_york_clock):
    # The rule utils/dates already states: an offset-less stamp is UTC
    # "so Python and TypeScript agree". The view delegates rather than
    # re-parsing, which is what three of the four translators got wrong.
    st = FileStat(name="f", type=FileType.TEXT, modified=NAIVE)
    assert mtime_ns(st) == UTC_NS


def test_aware_and_offsetless_stamps_agree(new_york_clock):
    naive = FileStat(name="f", type=FileType.TEXT, modified=NAIVE)
    aware = FileStat(name="f", type=FileType.TEXT, modified=NAIVE + "+00:00")
    zulu = FileStat(name="f", type=FileType.TEXT, modified=NAIVE + "Z")
    assert mtime_ns(naive) == mtime_ns(aware) == mtime_ns(zulu)


def test_missing_or_garbage_mtime_is_none():
    assert mtime_ns(FileStat(name="f", type=FileType.TEXT)) is None
    assert mtime_ns(
        FileStat(name="f", type=FileType.TEXT,
                 modified="yesterday-ish")) is None


def test_epoch_zero_is_a_real_time_not_unknown():
    st = FileStat(name="f",
                  type=FileType.TEXT,
                  modified="1970-01-01T00:00:00Z")
    assert mtime_ns(st) == 0


def test_directory_size_is_zero_whatever_the_backend_reports():
    st = FileStat(name="d", type=FileType.DIRECTORY, size=4096)
    assert content_size(st) == 0
    assert is_dir(st)


def test_unknown_size_reads_as_zero():
    st = FileStat(name="f", type=FileType.TEXT)
    assert content_size(st) == 0
    assert not is_dir(st)


def test_known_size_passes_through():
    assert content_size(FileStat(name="f", type=FileType.TEXT, size=11)) == 11


def test_mode_constants_carry_type_bits():
    assert DIR_MODE == (S_IFDIR | 0o755)
    assert FILE_MODE == (S_IFREG | 0o644)
