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

from mirage.commands.builtin.slack.io import IO
from mirage.core.slack.read import read as core_read
from mirage.core.slack.readdir import readdir as core_readdir
from mirage.core.slack.stat import stat as core_stat
from mirage.ops.slack import OPS


def _op(name: str):
    return next(o.fn for o in OPS if o.name == name and o.filetype is None)


def test_registers_read_only_trio():
    rows = {(o.name, o.resource, o.filetype, o.write) for o in OPS}
    assert rows == {
        ("read", "slack", None, False),
        ("readdir", "slack", None, False),
        ("stat", "slack", None, False),
    }


def test_table_wires_core_functions():
    assert IO.read_bytes is core_read
    assert IO.readdir is core_readdir
    assert IO.stat is core_stat


def test_ops_resolve_to_callables():
    for name in ("read", "readdir", "stat"):
        assert callable(_op(name))
