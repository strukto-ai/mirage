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

import errno

import pytest

from mirage.context import (
    effective_mount_mode,
    effective_path_mode,
    get_current_session,
    get_current_session_for,
    get_current_session_unless_foreign,
    hidden_refusal,
    readonly_below,
    require_mount_writable,
    reset_current_session,
    reset_mount_gate,
    session_visibility,
    set_current_session,
    set_mount_gate,
    strongest_mode_under,
)
from mirage.types import (
    HiddenPaths,
    MountMode,
    ShowEntry,
    ShownPaths,
    Visibility,
    weaker_mode,
)
from mirage.utils.errors import ReadOnlyError
from mirage.utils.hidden import hidden_under, path_visible
from mirage.workspace.session import SessionManager, SessionState


@pytest.fixture
def bound_session():
    sess = SessionState(
        session_id="agent",
        mount_modes={
            "/ro": MountMode.READ,
            "/rw": MountMode.WRITE,
            "/ex": MountMode.EXEC,
        },
    )
    token = set_current_session(sess)
    yield sess
    reset_current_session(token)


def test_weaker_mode_lattice():
    assert weaker_mode(MountMode.READ, MountMode.WRITE) == MountMode.READ
    assert weaker_mode(MountMode.WRITE, MountMode.READ) == MountMode.READ
    assert weaker_mode(MountMode.EXEC, MountMode.WRITE) == MountMode.WRITE
    assert weaker_mode(MountMode.EXEC, MountMode.EXEC) == MountMode.EXEC


def test_no_session_is_unrestricted():
    assert get_current_session() is None
    assert (
        effective_mount_mode("/anything", MountMode.WRITE) == MountMode.WRITE
    )


def test_unrestricted_session_keeps_mount_mode():
    token = set_current_session(SessionState(session_id="free"))
    try:
        assert effective_mount_mode("/s3", MountMode.EXEC) == MountMode.EXEC
    finally:
        reset_current_session(token)


def test_a_role_narrows_the_mount_mode(bound_session):
    assert effective_mount_mode("/ro", MountMode.WRITE) == MountMode.READ
    assert effective_mount_mode("/rw", MountMode.EXEC) == MountMode.WRITE


def test_a_role_cannot_widen_the_mount_mode(bound_session):
    assert effective_mount_mode("/ex", MountMode.READ) == MountMode.READ
    assert effective_mount_mode("/rw", MountMode.READ) == MountMode.READ


def test_prefix_normalization(bound_session):
    assert effective_mount_mode("/ro/", MountMode.WRITE) == MountMode.READ


def test_a_mount_the_role_does_not_name_keeps_its_own_mode(bound_session):
    # Naming three mounts is not an allowlist: a fourth is reachable at
    # whatever the workspace gave it. A role that must not touch a mount
    # hides it, which reads as ENOENT rather than as a permission error
    # naming something the role cannot see.
    assert effective_mount_mode("/other", MountMode.EXEC) == MountMode.EXEC
    assert effective_mount_mode("/", MountMode.WRITE) == MountMode.WRITE


def test_ownership_gates_the_binding():
    """A binding answers only the manager that published it."""
    mine = SessionManager("default")
    theirs = SessionManager("default")
    sess = SessionState(session_id="default")
    token = set_current_session(sess, owner=mine)
    try:
        assert get_current_session_for(mine) is sess
        assert get_current_session_for(theirs) is None
        assert get_current_session() is sess
    finally:
        reset_current_session(token)


def test_a_nested_binding_keeps_the_owner():
    """A background job's fork is still the workspace's own session."""
    mine = SessionManager("default")
    outer = SessionState(session_id="default")
    inner = SessionState(session_id="default")
    outer_token = set_current_session(outer, owner=mine)
    inner_token = set_current_session(inner)
    try:
        assert get_current_session_for(mine) is inner
    finally:
        reset_current_session(inner_token)
        reset_current_session(outer_token)


def test_an_unowned_binding_answers_nobody():
    """The op-dispatch binders name no owner, so no line adopts one."""
    token = set_current_session(SessionState(session_id="default"))
    try:
        assert get_current_session_for(SessionManager("default")) is None
    finally:
        reset_current_session(token)


def test_the_boundary_reads_the_bound_sessions_visibility():
    # One list per session, built by the compiler from the role's own
    # `paths.hide` and every mount section's, exact entries and glob
    # patterns told apart once by `classify_paths`.
    hidden = HiddenPaths(
        paths=("/a/secrets", "/shared/finance"), patterns=("/repo/*.pem",)
    )
    sess = SessionState(
        session_id="agent",
        visibility=Visibility(paths=hidden),
    )
    assert session_visibility() is None
    assert path_visible(session_visibility(), "/a/secrets/x")
    token = set_current_session(sess)
    try:
        vis = session_visibility()
        assert vis is sess.visibility
        assert not path_visible(vis, "/a/secrets/x")
        assert not path_visible(vis, "/shared/finance/q1.csv")
        assert not path_visible(vis, "/repo/certs/k.pem")
        assert path_visible(vis, "/repo/README")
        assert path_visible(vis, "/shared/public")
    finally:
        reset_current_session(token)


class _Gate:
    def __init__(self, scoped: bool, refused: str = "") -> None:
        self.scoped = scoped
        self.refused = refused
        self.asked: list[str] = []

    def check(self, virtual: str) -> None:
        self.asked.append(virtual)
        if virtual == self.refused:
            raise PermissionError(virtual)

    def refuses(self, virtual: str) -> bool:
        return virtual == self.refused


def test_the_admission_binding_is_scoped_to_one_command():
    from mirage.context import (
        get_admission,
        reset_admission,
        set_admission,
    )

    assert get_admission() is None
    outer = _Gate(scoped=True)
    token = set_admission(outer)
    try:
        assert get_admission() is outer
        # A nested line binds its own and hands the outer one back.
        inner = _Gate(scoped=False)
        inner_token = set_admission(inner)
        try:
            assert get_admission() is inner
        finally:
            reset_admission(inner_token)
        assert get_admission() is outer
    finally:
        reset_admission(token)
    assert get_admission() is None


def test_the_op_policies_binding_is_scoped_to_one_command():
    from mirage.context import (
        get_op_policies,
        reset_op_policies,
        set_op_policies,
    )
    from mirage.policy.policies import Policies

    assert get_op_policies() is None
    policies = Policies([])
    token = set_op_policies(policies)
    try:
        assert get_op_policies() is policies
    finally:
        reset_op_policies(token)
    assert get_op_policies() is None


def test_effective_path_mode_is_the_anchor_depth_rule():
    sess = SessionState(
        session_id="agent",
        mount_modes={"/repo": MountMode.READ},
        visibility=Visibility(
            shown=ShownPaths(
                entries=(
                    ShowEntry("/repo/build", MountMode.WRITE),
                    ShowEntry("/repo/tools", MountMode.EXEC),
                )
            )
        ),
    )
    token = set_current_session(sess)
    try:
        # The mount cap holds where no deeper entry speaks...
        assert (
            effective_path_mode("/repo/README.md", "/repo", MountMode.EXEC)
            == MountMode.READ
        )
        # ...and the deeper show entry wins below its anchor.
        assert (
            effective_path_mode("/repo/build/out", "/repo", MountMode.EXEC)
            == MountMode.WRITE
        )
        assert (
            effective_path_mode("/repo/tools/go.py", "/repo", MountMode.EXEC)
            == MountMode.EXEC
        )
        # The configured mode stays the strongest answer possible.
        assert (
            effective_path_mode("/repo/tools/go.py", "/repo", MountMode.READ)
            == MountMode.READ
        )
    finally:
        reset_current_session(token)


def test_effective_path_mode_without_a_session_is_the_mounts_own():
    assert (
        effective_path_mode("/a/x", "/a", MountMode.WRITE) == MountMode.WRITE
    )


def test_an_equal_depth_pair_takes_the_weaker():
    sess = SessionState(
        session_id="agent",
        mount_modes={"/repo": MountMode.EXEC},
        visibility=Visibility(
            shown=ShownPaths(entries=(ShowEntry("/repo", MountMode.READ),))
        ),
    )
    token = set_current_session(sess)
    try:
        assert (
            effective_path_mode("/repo/x", "/repo", MountMode.EXEC)
            == MountMode.READ
        )
    finally:
        reset_current_session(token)


def test_strongest_mode_under_counts_a_show_grant():
    sess = SessionState(
        session_id="agent",
        mount_modes={"/repo": MountMode.READ},
        visibility=Visibility(
            shown=ShownPaths(
                entries=(ShowEntry("/repo/build", MountMode.WRITE),)
            )
        ),
    )
    token = set_current_session(sess)
    try:
        # The mount-wide mode is READ, but a deeper grant makes a write
        # command runnable; the op door then refuses per path.
        assert strongest_mode_under("/repo", MountMode.EXEC) == MountMode.WRITE
        # Capped by the configured mode, and other mounts unaffected.
        assert strongest_mode_under("/repo", MountMode.READ) == MountMode.READ
        assert strongest_mode_under("/other", MountMode.READ) == MountMode.READ
    finally:
        reset_current_session(token)


def test_readonly_below_blames_the_carved_anchor():
    sess = SessionState(
        session_id="agent",
        visibility=Visibility(
            shown=ShownPaths(
                entries=(
                    ShowEntry("/repo/tree/locked", MountMode.READ),
                    ShowEntry("/repo/tree/locked/pub", MountMode.WRITE),
                )
            )
        ),
    )
    token = set_current_session(sess)
    try:
        # The anchor lies strictly below the operand, so a subtree
        # mutation over it is refused, and the deeper re-widening does
        # not clear it (the region between the two stays read-only).
        assert (
            readonly_below("/repo/tree", "/repo", MountMode.WRITE)
            == "/repo/tree/locked"
        )
        assert (
            readonly_below("/repo", "/repo", MountMode.WRITE)
            == "/repo/tree/locked"
        )
        # The operand itself or a sibling is the flat check's business.
        assert (
            readonly_below("/repo/tree/locked", "/repo", MountMode.WRITE)
            is None
        )
        assert readonly_below("/repo/other", "/repo", MountMode.WRITE) is None
    finally:
        reset_current_session(token)
    assert readonly_below("/repo/tree", "/repo", MountMode.WRITE) is None


def test_readonly_below_blames_the_operand_for_a_pattern():
    sess = SessionState(
        session_id="agent",
        visibility=Visibility(
            shown=ShownPaths(
                entries=(ShowEntry("/repo/*/locked", MountMode.READ),)
            )
        ),
    )
    token = set_current_session(sess)
    try:
        # A pattern names no single anchor, so the operand is blamed
        # whenever the match space could reach below it.
        assert (
            readonly_below("/repo/tree", "/repo", MountMode.WRITE)
            == "/repo/tree"
        )
        assert readonly_below("/other/tree", "/repo", MountMode.WRITE) is None
    finally:
        reset_current_session(token)


def test_require_mount_writable_needs_the_broad_grant():
    sess = SessionState(
        session_id="agent",
        mount_modes={"/trello": MountMode.READ},
        visibility=Visibility(
            shown=ShownPaths(
                entries=(ShowEntry("/trello/board", MountMode.WRITE),)
            )
        ),
    )
    session_token = set_current_session(sess)
    gate_token = set_mount_gate("/trello", MountMode.WRITE)
    try:
        # The carve-out admits the command, but an id-addressed write
        # names no path, so only the mount-wide grant counts.
        with pytest.raises(ReadOnlyError):
            require_mount_writable()
    finally:
        reset_mount_gate(gate_token)
        reset_current_session(session_token)
    # Unrestricted (no session narrowing) writes pass, and with no
    # mount bound the check is inert.
    gate_token = set_mount_gate("/trello", MountMode.WRITE)
    try:
        require_mount_writable()
    finally:
        reset_mount_gate(gate_token)
    require_mount_writable()


def test_hidden_under_is_per_operand():
    sess = SessionState(
        session_id="agent",
        visibility=Visibility(paths=HiddenPaths(paths=("/repo/.env",))),
    )
    token = set_current_session(sess)
    try:
        assert hidden_under(session_visibility(), "/repo")
        assert hidden_under(session_visibility(), "/repo/.env")
        assert not hidden_under(session_visibility(), "/s3")
    finally:
        reset_current_session(token)
    assert not hidden_under(session_visibility(), "/repo")


def test_hidden_refusal_answers_a_create_by_its_parent():
    # A create under a hidden directory is ENOENT, the answer every read
    # gives for that directory, so probing creates cannot map a
    # profile's hidden prefixes; a hidden name under a visible parent is
    # EACCES, the way an existing file the session cannot write is.
    sess = SessionState(
        session_id="agent",
        visibility=Visibility(
            paths=HiddenPaths(
                paths=("/w/vault", "/w/open/file.txt"), patterns=("*.key",)
            )
        ),
    )
    vis = sess.visibility
    under = hidden_refusal(vis, "/w/vault/new.txt", create=True)
    assert under.errno == errno.ENOENT
    assert under.filename == "/w/vault/new.txt"
    assert (
        hidden_refusal(vis, "/w/vault/a/b", create=True).errno == errno.ENOENT
    )
    assert hidden_refusal(vis, "/w/vault", create=True).errno == errno.EACCES
    assert hidden_refusal(vis, "/w/vault/", create=True).errno == errno.EACCES
    assert (
        hidden_refusal(vis, "/w/open/file.txt", create=True).errno
        == errno.EACCES
    )
    assert (
        hidden_refusal(vis, "/w/open/new.key", create=True).errno
        == errno.EACCES
    )
    assert (
        hidden_refusal(vis, "/w/vault/new.txt", create=False).errno
        == errno.ENOENT
    )
    assert (
        hidden_refusal(vis, "/w/open/file.txt", create=False).errno
        == errno.ENOENT
    )


def test_the_op_door_keeps_any_bind_but_another_owners():
    # A kernel mount and a guest runtime bind without an owner, and
    # the door keeps those; only a binding another workspace made is
    # refused, since its session describes that workspace's view.
    mine = SessionManager("default")
    theirs = SessionManager("default")
    sess = SessionState(session_id="default")
    assert get_current_session_unless_foreign(mine) is None
    token = set_current_session(sess)
    try:
        assert get_current_session_unless_foreign(mine) is sess
    finally:
        reset_current_session(token)
    token = set_current_session(sess, mine)
    try:
        assert get_current_session_unless_foreign(mine) is sess
        assert get_current_session_unless_foreign(theirs) is None
    finally:
        reset_current_session(token)
