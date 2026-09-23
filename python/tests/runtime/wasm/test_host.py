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

import inspect

import pytest

pytest.importorskip("wasmtime")

from mirage.runtime.wasm.abi import (  # noqa: E402  # isort: skip
    EINVAL, EIO, ENOENT, FST_ATIM, FST_ATIM_NOW, FST_MTIM, FST_MTIM_NOW,
    FT_CHR, FT_DIR, FT_REG, FT_SYMLINK)
from mirage.runtime.wasm.host import (  # noqa: E402  # isort: skip
    WasiFs, _call_guarded, _filetype, _spec, _stamp)
from mirage.runtime.types import VFSStat  # noqa: E402

from mirage.utils.stat_view import (  # noqa: E402  # isort: skip
    CHAR_MODE, DIR_MODE, FILE_MODE, LINK_MODE)

# End-to-end host-function behavior (path_open buffering, fd table,
# errno answers inside a real guest) is covered by the live wasi and
# quickjs batteries; this file guards the ABI table itself.


def test_spec_names_all_resolve_to_methods_with_matching_arity():
    for name, (params, results) in _spec().items():
        method = getattr(WasiFs, name)
        # self + caller + one parameter per wasm value type.
        arity = len(inspect.signature(method).parameters)
        assert arity == len(params) + 2, name
        assert len(results) == 1, name


def test_spec_covers_every_fs_import_of_the_shipped_guests():
    # python.wasm imports 28 preview1 fs functions; qjs-wasi.wasm a
    # 16-function subset. fd_renumber is shadowed too (dup2 support).
    assert len(_spec()) == 29


def _raising(exc):
    """A host function double that fails with `exc`.

    Args:
        exc (BaseException): what the call raises.
    """

    def fn(caller, *args):
        raise exc

    return fn


def test_guarded_call_maps_an_fs_error_to_its_errno():
    assert _call_guarded(_raising(FileNotFoundError("x")), None) == ENOENT
    assert _call_guarded(_raising(ValueError("row too large")), None) == EINVAL


def test_guarded_call_answers_eio_for_an_upstream_failure():
    # One record a remote API refuses must fail the guest's call on it,
    # not trap the whole run the guest could have finished without it.
    upstream = RuntimeError("upstream 502 Bad Gateway")
    assert _call_guarded(_raising(upstream), None) == EIO


def test_filetype_reads_the_kind_link_first():
    link = VFSStat(size=3,
                   is_dir=False,
                   mode=LINK_MODE,
                   mtime_ns=0,
                   is_link=True)
    assert _filetype(link) == FT_SYMLINK
    assert _filetype(VFSStat(size=0, is_dir=True, mode=DIR_MODE,
                             mtime_ns=0)) == FT_DIR
    assert _filetype(VFSStat(size=1, is_dir=False, mode=FILE_MODE,
                             mtime_ns=0)) == FT_REG
    assert _filetype(VFSStat(size=0, is_dir=False, mode=CHAR_MODE,
                             mtime_ns=0)) == FT_CHR


def test_stamp_omits_a_field_no_flag_selected():
    # Neither bit set is utimensat's UTIME_OMIT: leave that stamp alone.
    assert _stamp(0, FST_MTIM, FST_MTIM_NOW, 5_000_000_000, 1.0) is None


def test_stamp_reads_the_argument_as_nanoseconds():
    assert _stamp(FST_MTIM, FST_MTIM, FST_MTIM_NOW, 200_000_000_000,
                  1.0) == "1970-01-01T00:03:20+00:00"


def test_stamp_now_wins_over_the_argument():
    # preview1 has both bits, and *_NOW means ignore the value entirely.
    both = FST_ATIM | FST_ATIM_NOW
    assert _stamp(both, FST_ATIM, FST_ATIM_NOW, 200_000_000_000,
                  100.0) == "1970-01-01T00:01:40+00:00"


def test_stamp_reads_only_its_own_half_of_the_flags():
    assert _stamp(FST_ATIM, FST_MTIM, FST_MTIM_NOW, 1, 1.0) is None
    assert _stamp(FST_MTIM, FST_ATIM, FST_ATIM_NOW, 1, 1.0) is None
