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

from mirage.runtime.wasm.host import WasiFs, _spec  # noqa: E402

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
