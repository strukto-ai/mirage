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
import stat
import time

import pytest

from mirage.mount.stat import apply_stat_attrs, dir_stat, file_stat, link_stat
from mirage.mount.types import MountAttrs
from mirage.types import ContentType, FileStat, FileType
from mirage.utils.dates import iso_timestamp

NOW = 1_700_000_000.0


def test_dir_stat_is_a_directory_owned_by_the_mounting_user():
    entry = dir_stat(uid=501, gid=20, now=NOW)

    assert stat.S_ISDIR(entry.mode)
    assert (entry.size, entry.nlink) == (0, 2)
    assert (entry.uid, entry.gid) == (501, 20)
    assert entry.mtime == NOW


def test_file_stat_carries_the_size_it_was_given():
    entry = file_stat(42, uid=501, gid=20, now=NOW)

    assert stat.S_ISREG(entry.mode)
    assert (entry.size, entry.nlink) == (42, 1)


def test_link_stat_is_lrwxrwxrwx_sized_by_the_target_string():
    entry = link_stat("../a.txt", None, uid=501, gid=20, now=NOW)

    assert stat.S_ISLNK(entry.mode)
    assert entry.mode & 0o7777 == 0o777
    assert entry.size == len("../a.txt")


def test_link_stat_keeps_the_link_mode_even_when_the_row_sets_one():
    # A symlink's permission bits are not consulted by any POSIX system,
    # so an overlaid chmod must not make the row read as a regular file.
    row = FileStat(name="lnk", type=FileType.SYMLINK, mode=0o600)

    entry = link_stat("a.txt", row, uid=0, gid=0, now=NOW)

    assert stat.S_ISLNK(entry.mode)


def test_link_stat_takes_the_rows_owner_and_stamp():
    row = FileStat(name="lnk",
                   type=FileType.SYMLINK,
                   uid=1234,
                   modified="2026-01-02T03:04:05Z")

    entry = link_stat("a.txt", row, uid=0, gid=0, now=NOW)

    assert entry.uid == 1234
    assert entry.mtime == iso_timestamp(row.modified)


def test_apply_stat_attrs_ignores_named_owners():
    # There is no user database to map a name against, and the kernel
    # wants a number, so a name leaves the mounting user in place.
    row = FileStat(name="f",
                   type=FileType.FILE,
                   content=ContentType.TEXT,
                   uid="alice",
                   gid="staff")

    entry = apply_stat_attrs(file_stat(0, uid=501, gid=20, now=NOW), row)

    assert (entry.uid, entry.gid) == (501, 20)


def test_apply_stat_attrs_keeps_the_type_bits_and_takes_the_permissions():
    row = FileStat(name="d", type=FileType.DIRECTORY, mode=0o700)

    entry = apply_stat_attrs(dir_stat(uid=0, gid=0, now=NOW), row)

    assert stat.S_ISDIR(entry.mode)
    assert entry.mode & 0o7777 == 0o700


@pytest.fixture
def new_york_clock():
    # Mirrors tests/utils/test_stat_view.py: a non-UTC host zone makes a
    # local-time parse of an offset-less stamp visibly wrong.
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


def test_overlay_mtime_reads_offsetless_stamps_as_utc(new_york_clock):
    # The R6 acceptance pin: the FUSE translator answers the same epoch
    # as mirage.utils.stat_view for an offset-less stamp. Only a
    # backend can produce one (the touch overlay always emits Z), so
    # this is latent until a backend like nextcloud reports naive
    # stamps; the pin is what keeps it latent.
    naive = FileStat(name="f",
                     type=FileType.FILE,
                     content=ContentType.TEXT,
                     modified="2026-01-02T03:04:05")
    aware = FileStat(name="f",
                     type=FileType.FILE,
                     content=ContentType.TEXT,
                     modified="2026-01-02T03:04:05+00:00")

    def row() -> MountAttrs:
        # A fresh row per fold: the overlay writes onto what it is given.
        return MountAttrs(mode=0o100644,
                          size=0,
                          nlink=1,
                          uid=0,
                          gid=0,
                          atime=0,
                          mtime=0,
                          ctime=0)

    got_naive = apply_stat_attrs(row(), naive)
    got_aware = apply_stat_attrs(row(), aware)
    assert got_naive.mtime == got_aware.mtime
    assert got_naive.mtime == iso_timestamp(naive.modified)


def test_epoch_zero_mtime_lands_instead_of_reading_as_unknown():
    # 1970-01-01T00:00:00Z is a real answer, not a missing stamp: the
    # fold keys on None, so epoch zero overwrites the construction-time
    # default instead of leaving it in place.
    epoch = FileStat(name="f",
                     type=FileType.FILE,
                     content=ContentType.TEXT,
                     modified="1970-01-01T00:00:00Z")
    row = MountAttrs(mode=0o100644,
                     size=0,
                     nlink=1,
                     uid=0,
                     gid=0,
                     atime=12345,
                     mtime=12345,
                     ctime=12345)
    got = apply_stat_attrs(row, epoch)
    assert got.mtime == 0
    assert got.ctime == 0


def test_the_times_are_seconds_and_fit_the_wire():
    # The unit is load-bearing and neither consumer can state it:
    # libfuse's st_mtime is seconds, and nfstime3.seconds is a u32, so
    # nanoseconds saturate it and date every file 2106-02-07. Both
    # rows are checked because a fresh one and an overlaid one took
    # their stamp from different places, and only one was ever wrong.
    fresh = file_stat(0, uid=0, gid=0, now=NOW)
    overlaid = apply_stat_attrs(
        file_stat(0, uid=0, gid=0, now=NOW),
        FileStat(name="f",
                 type=FileType.FILE,
                 content=ContentType.TEXT,
                 modified="2026-01-02T03:04:05Z"))

    for entry in (fresh, overlaid):
        assert 1_000_000_000 < entry.mtime < 2**32
        assert entry.mtime == entry.ctime
