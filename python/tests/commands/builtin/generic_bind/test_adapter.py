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

from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.builders import BUILDERS
from mirage.commands.spec import SPECS


async def _noop(accessor, paths, texts, ctx):
    return None


def test_a_generic_command_reads_writes_and_streams_nothing_by_default():
    builder = GenericCommand("x", _noop)
    assert (
        builder.write,
        builder.read,
        builder.pass_through,
        builder.streams,
        builder.aggregate,
    ) == (False, False, False, False, None)


def test_every_builder_is_an_ordinary_handler_with_a_spec():
    # A builder is called as every command is, (accessor, paths, texts,
    # ctx), and reads its files through ``ctx.vfs`` alone.
    for builder in BUILDERS:
        assert isinstance(builder, GenericCommand)
        assert builder.name in SPECS
        params = tuple(inspect.signature(builder.fn).parameters)
        assert params == ("accessor", "paths", "texts", "ctx"), builder.name
