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

from collections.abc import Callable
from typing import Any

from mirage.commands.builtin.generic_bind.adapter import (CommandIO,
                                                          with_path_guards,
                                                          with_policy_guard)
from mirage.commands.builtin.generic_bind.factory import with_slash_guard
from mirage.commands.builtin.object_store.mkdir import make_mkdir
from mirage.commands.builtin.object_store.rm import make_rm
from mirage.commands.builtin.object_store.stat import make_stat
from mirage.commands.builtin.object_store.tee import make_tee
from mirage.commands.builtin.object_store.touch import make_touch

# Keyed-store behaviours kept as overrides of the generic commands: no
# real directories (mkdir -p, rm not-empty), write-tracking (touch/tee),
# and the index-threaded, missing-operand stat.
OBJECT_STORE_OVERRIDES = {"stat", "rm", "mkdir", "tee", "touch"}


def make_object_store_commands(vfs: str,
                               io: CommandIO) -> list[Callable[..., Any]]:
    """Build the five keyed-store command overrides for one backend.

    The op table is wrapped with the same hidden/rule/mode chain the
    factory gives every generic command, the policy guard outermost as
    there, so an override enforces the session's path axis and the
    coded op policies exactly like the generic it replaces. The slash
    guard rides along for the same reason: ``tee missing/`` on a keyed
    store must refuse as the generic does instead of writing a key
    called ``missing``.

    Args:
        vfs (str): VFS name the commands register under.
        io (CommandIO): the backend's op table; must wire the write-side
            slots the overrides consume.
    """
    io = with_policy_guard(with_slash_guard(with_path_guards(io)))
    return [
        make_mkdir(vfs, io),
        make_rm(vfs, io),
        make_stat(vfs, io),
        make_tee(vfs, io),
        make_touch(vfs, io),
    ]
