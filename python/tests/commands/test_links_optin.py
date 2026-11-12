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

from tests.fixtures.mount_commands import registered_commands as _registered

# The families whose generics read the command's links (ls/stat/find/
# file). Since Context carries the files into every handler, link
# awareness is inherited by delegating to the family generic — so the invariant
# worth pinning is the delegation itself: a bespoke wrapper that walks
# its own tree cannot see a link, still runs, still exits 0, and nothing
# notices until someone makes a link on that backend.
LINK_AWARE = ("ls", "stat", "find", "file")

# The spellings of delegation: the family's full-command generic entry.
GENERIC_CALLS = {
    "ls": ("ls_generic(",),
    "stat": ("stat_generic(", "generic_stat("),
    "find": ("find_generic(",),
    "file": ("file_generic(",),
}


def test_every_link_aware_shadow_delegates_to_the_generic():
    """A bespoke command in a link-aware family must route through it.

    ``Context`` hands every handler the namespace facts, but only
    the family generic interprets them; a wrapper that walks its own
    tree ctx the whole backend out of symlinks without failing
    anything. Mirrors the TS state, where every bespoke find/ls routes
    through the generic (``findGeneric``/``walkFind``).
    """
    commands, failed = _registered()
    assert not failed, f"builtin modules would not import: {failed}"
    assert commands, "no registered builtin commands were found"
    offenders = []
    for cmd in commands:
        if cmd.name not in LINK_AWARE:
            continue
        fn = inspect.unwrap(cmd.fn)
        source_file = inspect.getsourcefile(fn) or ""
        if "/generic_bind/" in source_file:
            continue
        source = inspect.getsource(inspect.getmodule(fn))
        if not any(call in source for call in GENERIC_CALLS[cmd.name]):
            offenders.append(f"{cmd.vfs}/{cmd.name} ({source_file})")
    assert not offenders, (
        "these commands shadow a link-aware family without delegating to "
        f"its generic, so symlinks are invisible to them: {offenders}"
    )
