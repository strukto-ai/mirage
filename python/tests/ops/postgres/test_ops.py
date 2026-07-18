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

from mirage.commands.builtin.postgres.ops import OPS as _TABLE
from mirage.core.postgres.read import read as core_read
from mirage.core.postgres.readdir import readdir as core_readdir
from mirage.core.postgres.stat import stat as core_stat
from mirage.ops.postgres import OPS


def _op(name: str):
    return next(o.fn for o in OPS if o.name == name and o.filetype is None)


def test_registers_read_only_trio():
    rows = {(o.name, o.resource, o.filetype, o.write) for o in OPS}
    assert rows == {
        ("read", "postgres", None, False),
        ("readdir", "postgres", None, False),
        ("stat", "postgres", None, False),
    }


def test_table_wires_core_functions():
    assert _TABLE.read_bytes is core_read
    assert _TABLE.readdir is core_readdir
    assert _TABLE.stat is core_stat


def test_ops_resolve_to_callables():
    for name in ("read", "readdir", "stat"):
        assert callable(_op(name))
