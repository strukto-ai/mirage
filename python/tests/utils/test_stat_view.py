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
from stat import S_IFDIR, S_IFIFO, S_IFREG

import pytest

from mirage.types import ContentType, FileStat, FileType
from mirage.utils.stat_view import (
    DIR_MODE,
    DIR_SIZE,
    FIFO_MODE,
    FILE_MODE,
    LINK_MODE,
    content_size,
    is_dir,
    is_fifo,
    is_link,
    mtime_ns,
    posix_mode,
    size_unknown,
)

NAIVE = "2026-01-02T03:04:05"
UTC_NS = int(
    datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc).timestamp()
    * 1_000_000_000
)


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
    st = FileStat(
        name="f", type=FileType.FILE, content=ContentType.TEXT, modified=NAIVE
    )
    assert mtime_ns(st) == UTC_NS


def test_aware_and_offsetless_stamps_agree(new_york_clock):
    naive = FileStat(
        name="f", type=FileType.FILE, content=ContentType.TEXT, modified=NAIVE
    )
    aware = FileStat(
        name="f",
        type=FileType.FILE,
        content=ContentType.TEXT,
        modified=NAIVE + "+00:00",
    )
    zulu = FileStat(
        name="f",
        type=FileType.FILE,
        content=ContentType.TEXT,
        modified=NAIVE + "Z",
    )
    assert mtime_ns(naive) == mtime_ns(aware) == mtime_ns(zulu)


def test_missing_or_garbage_mtime_is_none():
    assert (
        mtime_ns(
            FileStat(name="f", type=FileType.FILE, content=ContentType.TEXT)
        )
        is None
    )
    assert (
        mtime_ns(
            FileStat(
                name="f",
                type=FileType.FILE,
                content=ContentType.TEXT,
                modified="yesterday-ish",
            )
        )
        is None
    )


def test_epoch_zero_is_a_real_time_not_unknown():
    st = FileStat(
        name="f",
        type=FileType.FILE,
        content=ContentType.TEXT,
        modified="1970-01-01T00:00:00Z",
    )
    assert mtime_ns(st) == 0


def test_directory_size_is_dir_size_whatever_the_backend_reports():
    st = FileStat(name="d", type=FileType.DIRECTORY, size=123456)
    assert content_size(st) == DIR_SIZE
    assert is_dir(st)


def test_unknown_size_reads_as_zero():
    st = FileStat(name="f", type=FileType.FILE, content=ContentType.TEXT)
    assert content_size(st) == 0
    assert not is_dir(st)


def test_known_size_passes_through():
    assert (
        content_size(
            FileStat(
                name="f", type=FileType.FILE, content=ContentType.TEXT, size=11
            )
        )
        == 11
    )


def test_mode_constants_carry_type_bits():
    assert DIR_MODE == (S_IFDIR | 0o755)
    assert FILE_MODE == (S_IFREG | 0o644)


def test_posix_mode_defaults_by_kind():
    file_st = FileStat(name="f", type=FileType.FILE, content=ContentType.TEXT)
    dir_st = FileStat(name="d", type=FileType.DIRECTORY)
    assert posix_mode(file_st) == FILE_MODE
    assert posix_mode(dir_st) == DIR_MODE


def test_posix_mode_takes_the_overlay_bits_and_keeps_the_kind():
    st = FileStat(name="d", type=FileType.DIRECTORY, mode=0o700)
    assert posix_mode(st) == (S_IFDIR | 0o700)
    st = FileStat(
        name="f", type=FileType.FILE, content=ContentType.TEXT, mode=0o600
    )
    assert posix_mode(st) == (S_IFREG | 0o600)


def test_posix_mode_reports_a_link_as_lrwxrwxrwx():
    st = FileStat(name="l", type=FileType.SYMLINK)
    assert posix_mode(st) == LINK_MODE
    # A chmod -h stores bits the overlay keeps, but no POSIX system
    # consults the bits on a symlink, so none of them are reported.
    st = FileStat(name="l", type=FileType.SYMLINK, mode=0o600)
    assert posix_mode(st) == LINK_MODE


def test_is_link_reads_the_kind():
    assert is_link(FileStat(name="l", type=FileType.SYMLINK)) is True
    assert (
        is_link(
            FileStat(name="f", type=FileType.FILE, content=ContentType.TEXT)
        )
        is False
    )


def test_link_mode_is_lrwxrwxrwx():
    assert LINK_MODE == 0o120777


def test_fifo_mode_is_prw_for_its_owner():
    assert FIFO_MODE == (S_IFIFO | 0o600)
    fifo = FileStat(name="63", type=FileType.FIFO)
    assert is_fifo(fifo)
    assert posix_mode(fifo) == FIFO_MODE
    assert posix_mode(fifo.model_copy(update={"mode": 0o640})) == (
        S_IFIFO | 0o640
    )


def test_size_unknown_spares_a_directory_and_a_fifo():
    assert size_unknown(
        FileStat(name="f", type=FileType.FILE, content=ContentType.TEXT)
    )
    assert not size_unknown(FileStat(name="d", type=FileType.DIRECTORY))
    fifo = FileStat(name="63", type=FileType.FIFO)
    assert not size_unknown(fifo)
    assert content_size(fifo) == 0
