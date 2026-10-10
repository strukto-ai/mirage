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

import ctypes
import errno
import sys

import pytest

from mirage.fuse import darwin
from mirage.fuse.constants import UTIME_NOW, UTIME_OMIT
from mirage.fuse.darwin import (
    RENAME_EXCL,
    RENAME_SWAP,
    SetattrX,
    changes_from_setattr,
    install_macfuse_extensions,
    rename_flags_check,
    timespec_ns,
)

try:
    import mfusepy
except (ImportError, OSError):
    mfusepy = None

requires_mfusepy = pytest.mark.skipif(
    mfusepy is None,
    reason="mfusepy needs a libfuse on the system (macFUSE, fuse3, WinFsp)",
)


def make_attr(valid: int, **fields: int) -> SetattrX:
    attr = SetattrX()
    attr.valid = valid
    for name, value in fields.items():
        setattr(attr, name, value)
    return attr


def test_decompose_reads_only_valid_bits():
    attr = make_attr(
        darwin.SETATTR_MODE | darwin.SETATTR_SIZE, mode=0o644, size=42, uid=999
    )
    changes = changes_from_setattr(attr)
    assert changes == {"mode": 0o644, "size": 42}


def test_decompose_fskit_create_payload():
    # The exact valid mask the FSKit shim sends when finalizing a new item
    # (mode|uid|gid|crtime|flags, observed as 0x90000007 on the wire).
    # crtime and BSD flags are accepted and dropped: mirage stores neither.
    attr = make_attr(
        (
            darwin.SETATTR_MODE
            | darwin.SETATTR_UID
            | darwin.SETATTR_GID
            | (1 << 28)
            | (1 << 31)
        ),
        mode=0o644,
        uid=501,
        gid=20,
    )
    changes = changes_from_setattr(attr)
    assert changes == {"mode": 0o644, "uid": 501, "gid": 20}


def test_decompose_times_are_nanoseconds():
    attr = SetattrX()
    attr.valid = darwin.SETATTR_ACCTIME | darwin.SETATTR_MODTIME
    attr.acctime.tv_sec = 10
    attr.acctime.tv_nsec = 500_000_000
    attr.modtime.tv_sec = 20
    changes = changes_from_setattr(attr)
    assert changes["acctime"] == 10_500_000_000
    assert changes["modtime"] == 20_000_000_000


def test_timespec_ns_reads_the_utimensat_markers():
    ts = darwin.Timespec()
    ts.tv_sec = 3
    ts.tv_nsec = 250_000_000
    assert timespec_ns(ts, 99) == 3_250_000_000
    ts.tv_nsec = UTIME_NOW
    assert timespec_ns(ts, 99) == 99
    ts.tv_nsec = UTIME_OMIT
    assert timespec_ns(ts, 99) is None


def test_rename_flags_plain_rename_proceeds():
    assert rename_flags_check(new_exists=True, flags=0) is None
    assert rename_flags_check(new_exists=False, flags=0) is None


def test_rename_flags_excl_rejects_existing_target():
    assert (
        rename_flags_check(new_exists=True, flags=RENAME_EXCL) == errno.EEXIST
    )
    assert rename_flags_check(new_exists=False, flags=RENAME_EXCL) is None


def test_rename_flags_swap_is_unsupported():
    # Atomic swap has no mirage-backend primitive; refusing beats faking.
    assert (
        rename_flags_check(new_exists=True, flags=RENAME_SWAP) == errno.ENOTSUP
    )


@requires_mfusepy
@pytest.mark.skipif(
    sys.platform != "darwin",
    reason="mfusepy builds fuse_operations per platform; the "
    "reserved tail the Apple fields replace only exists in "
    "the Darwin layout",
)
def test_install_extends_struct_and_keeps_size(monkeypatch):
    monkeypatch.setattr(darwin, "_installed", False)
    monkeypatch.setattr(darwin.sys, "platform", "darwin")
    before = ctypes.sizeof(mfusepy.fuse_operations)
    install_macfuse_extensions(mfusepy)
    names = [f[0] for f in mfusepy.fuse_operations._fields_]
    assert "setattr_x" in names
    assert "renamex" in names
    assert "fsetattr_x" in names
    # The Apple tail replaces mfusepy's reserved slots one-for-one, so the
    # struct libfuse receives must not change size.
    assert ctypes.sizeof(mfusepy.fuse_operations) == before
    assert hasattr(mfusepy.FUSE, "setattr_x")
    assert hasattr(mfusepy.FUSE, "renamex")


@requires_mfusepy
def test_install_is_idempotent(monkeypatch):
    monkeypatch.setattr(darwin, "_installed", False)
    monkeypatch.setattr(darwin.sys, "platform", "darwin")
    install_macfuse_extensions(mfusepy)
    fields_after_first = mfusepy.fuse_operations
    install_macfuse_extensions(mfusepy)
    assert mfusepy.fuse_operations is fields_after_first


@requires_mfusepy
def test_install_skips_off_darwin(monkeypatch):
    monkeypatch.setattr(darwin, "_installed", False)
    monkeypatch.setattr(darwin.sys, "platform", "linux")
    saved = mfusepy.fuse_operations
    install_macfuse_extensions(mfusepy)
    assert mfusepy.fuse_operations is saved
