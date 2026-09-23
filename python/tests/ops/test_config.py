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

from mirage.ops.config import NO_FOLLOW_OPS, STAMP_WRITE_OPS, NamespaceLinks
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

# The seam's members in declaration order. The TypeScript twin
# (ops/config.test.ts) pins this same list camelCased and in this same
# order, so a member added, dropped or moved in one language fails the
# other language's test instead of drifting quietly.
MEMBERS = ("follow", "is_link", "readlink", "link_stat_at", "symlink_targets")


def _declared() -> tuple[str, ...]:
    return tuple(name for name in vars(NamespaceLinks)
                 if not name.startswith("_"))


def test_members_and_declaration_order():
    assert _declared() == MEMBERS


def test_the_seam_carries_no_mutator():
    # Creating and removing a link belongs to the op door, which is the
    # only layer that sees both planes: it decides symlink(2)'s refusal
    # to overwrite an occupied name, and it is where session grants,
    # admission policies and the ledger fire. A mutator here is a write
    # at a layer no session view covers, which is how a session-scoped
    # kernel mount came to delete a link on a mount its profile hides.
    assert not hasattr(NamespaceLinks, "symlink")
    assert not hasattr(NamespaceLinks, "unlink")


def test_every_member_is_a_plain_read():
    # A node-table write is async on the concrete Namespace, so a
    # mutator cannot reach this seam without arriving as a coroutine
    # member. No member being one is the read-only property itself.
    assert not [
        name for name in MEMBERS
        if inspect.iscoroutinefunction(getattr(NamespaceLinks, name))
    ]


def test_namespace_satisfies_the_narrowed_protocol():
    # Narrowing the seam must not cost the structural match: the
    # workspace Namespace still answers every member, and keeps the
    # mutators the door calls on it directly.
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    assert isinstance(ws.namespace, NamespaceLinks)
    assert inspect.iscoroutinefunction(ws.namespace.symlink)
    assert inspect.iscoroutinefunction(ws.namespace.unlink)


def test_link_entry_ops_never_follow():
    # lstat semantics: the operand names the link itself, so no stat
    # surface may rewrite it through the table.
    assert set(NO_FOLLOW_OPS) == {
        "unlink", "rename", "rmdir", "symlink", "readlink"
    }


def test_removals_do_not_stamp_an_mtime():
    assert "unlink" not in STAMP_WRITE_OPS
    assert "rmdir" not in STAMP_WRITE_OPS
    assert "write" in STAMP_WRITE_OPS
