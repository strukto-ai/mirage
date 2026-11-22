import pytest

from mirage.execution.process.config import ProcessPermissions
from mirage.policy.errors import PolicyError
from mirage.policy.profile import (
    PathsBlock,
    ProfileMount,
    SessionProfile,
    VarsBlock,
    tree_doc,
)
from mirage.policy.types import HideReason
from mirage.rs.policy import rule_table
from mirage.shell.variable import VarAttr
from mirage.types import (
    HiddenPaths,
    HiddenVars,
    MountMode,
    ShowEntry,
    ShownPaths,
)
from mirage.utils.hidden import path_visible
from mirage.workspace.session.resolve import (
    apply_profile,
    command_rules,
    compile_profile,
    narrow,
    resolve_profile,
    with_inline,
)
from mirage.workspace.session.session import SessionState
from mirage.workspace.session.validate import BUILTIN_GRAMMARS

PROFILES = {
    "default": SessionProfile(
        cwd="/scratch",
        env={"PAGER": "cat"},
        mounts={"/repo": "r", "/scratch": "rwx"},
    ),
    "reviewer": SessionProfile(
        paths=PathsBlock(hide=("/repo/.env",)), env={"ROLE": "reviewer"}
    ),
}


def test_resolve_profile_names_objects_and_the_default():
    assert resolve_profile(PROFILES, "reviewer") is PROFILES["reviewer"]
    assert resolve_profile(PROFILES, None) is PROFILES["default"]
    assert resolve_profile({}, None) is None
    plain = SessionProfile(cwd="/x")
    assert resolve_profile(PROFILES, plain) is plain


def test_resolve_profile_refuses_an_unknown_name():
    with pytest.raises(PolicyError, match="unknown profile 'nope'"):
        resolve_profile(PROFILES, "nope")


def test_with_inline_keeps_the_profiles_tree_and_command_rules_reads_both():
    base = SessionProfile(commands={"rm": {"-r": "ask"}})
    inline = SessionProfile(
        commands={"rm": "deny"}, paths=PathsBlock(hide=("/secret",))
    )
    merged = with_inline(base, inline)
    assert merged is not None and merged.commands == base.commands
    rules = command_rules(base, inline, BUILTIN_GRAMMARS)
    assert rules is not None
    assert [(t.mount, t.inline) for t in rules.trees] == [
        ("", False),
        ("", True),
    ]
    assert tree_doc(rules.trees[1].tree) == {"rm": "deny"}
    compiled = compile_profile(merged, commands=rules).policies.commands
    assert compiled is rules


def test_with_inline_takes_the_weaker_mode_per_mount():
    base = SessionProfile(mounts={"/a": "rwx", "/b": "r"})
    inline = SessionProfile(mounts={"/a": "rw", "/c": "rwx"})
    out = with_inline(base, inline)
    assert out is not None and out.mounts is not None
    # Every prefix either side names survives; a mount only the inline
    # document names is not a grant, since a mount the profile never named
    # was already reachable at its own mode.
    assert out.mounts["/a"].mode is MountMode.WRITE
    assert out.mounts["/b"].mode is MountMode.READ
    assert out.mounts["/c"].mode is MountMode.EXEC


def test_with_inline_unions_hides_and_lets_inline_presets_win():
    base = SessionProfile(
        cwd="/scratch",
        env={"PAGER": "cat", "A": "1"},
        paths=PathsBlock(hide=("/repo/.env", "*.pem")),
        vars=VarsBlock(hide=("AWS_*",)),
    )
    inline = SessionProfile(
        cwd="/repo",
        env={"A": "2"},
        paths=PathsBlock(hide=("*.pem", "/repo/secrets")),
        vars=VarsBlock(hide=("SLACK_TOKEN",)),
    )
    out = with_inline(base, inline)
    assert out is not None
    assert out.cwd == "/repo"
    assert out.env == {"PAGER": "cat", "A": "2"}
    assert out.paths == PathsBlock(
        hide=("/repo/.env", "*.pem", "/repo/secrets")
    )
    assert out.vars == VarsBlock(hide=("AWS_*", "SLACK_TOKEN"))


def test_with_inline_merges_one_mount_section():
    base = SessionProfile(
        mounts={
            "/repo": ProfileMount(
                mode=MountMode.WRITE,
                commands={"rm": "deny"},
                paths=PathsBlock(hide=("/repo/.env",)),
            )
        }
    )
    inline = SessionProfile(
        mounts={
            "/repo": ProfileMount(
                commands={"cp": "ask"},
                paths=PathsBlock(hide=("/repo/secrets",)),
            )
        }
    )
    entry = with_inline(base, inline).mounts["/repo"]
    assert entry.mode is MountMode.WRITE
    assert entry.commands is not None
    assert tree_doc(entry.commands) == {"rm": "deny"}
    rules = command_rules(base, inline, BUILTIN_GRAMMARS)
    assert rules is not None
    assert [(t.mount, t.inline) for t in rules.trees] == [
        ("/repo", False),
        ("/repo", True),
    ]
    assert entry.paths == PathsBlock(hide=("/repo/.env", "/repo/secrets"))


def test_with_inline_with_one_side_missing_is_the_other():
    p = SessionProfile(cwd="/x")
    assert with_inline(None, p) is p
    assert with_inline(p, None) is p
    assert with_inline(None, None) is None


def test_command_rules_holds_each_mounts_tree_with_its_prefix():
    rules = command_rules(
        SessionProfile(
            commands={"*": "deny", "ls": "allow"},
            mounts={
                "/repo": ProfileMount(
                    commands={
                        "rm": "deny",
                        "git": {"push": "ask"},
                    }
                ),
                "/scratch": ProfileMount(mode=MountMode.READ),
            },
        ),
        None,
        BUILTIN_GRAMMARS,
        defer=True,
    )
    assert rules is not None
    assert [t.mount for t in rules.trees] == ["", "/repo"]
    leaves = {rule.at: rule for rule in rule_table(rules)}
    assert leaves["/rm/*"].mount == "/repo"
    assert leaves["/*"].mount == ""


def test_command_rules_is_none_when_no_document_states_a_tree():
    bare = SessionProfile(mounts={"/repo": ProfileMount(mode=MountMode.READ)})
    assert command_rules(bare, None, BUILTIN_GRAMMARS) is None
    assert command_rules(None, None, BUILTIN_GRAMMARS) is None
    assert compile_profile(SessionProfile()).policies.commands is None


def test_compile_profile_turns_the_document_into_session_fields():
    out = compile_profile(
        SessionProfile(
            cwd="/scratch",
            env={"ROLE": "x"},
            mounts={"/a": "rw", "/b": "r"},
            paths=PathsBlock(hide=("/a/secrets", "*.key")),
            vars=VarsBlock(hide=("SLACK_TOKEN", "AWS_*")),
        )
    )
    assert out.policies.mount_modes == {
        "/a": MountMode.WRITE,
        "/b": MountMode.READ,
    }
    assert out.visibility.paths == HiddenPaths(
        paths=("/a/secrets",), patterns=("*.key",)
    )
    assert out.visibility.vars == HiddenVars(
        names=("SLACK_TOKEN",), patterns=("AWS_*",)
    )
    assert out.setup.env == {"ROLE": "x"}
    assert out.setup.cwd == "/scratch"


def test_compile_profile_collects_the_hides_of_every_mount_section():
    out = compile_profile(
        SessionProfile(
            paths=PathsBlock(hide=("/shared/finance",)),
            mounts={
                "/repo": ProfileMount(
                    paths=PathsBlock(hide=("/repo/.env", "*.pem"))
                ),
                "/scratch": ProfileMount(mode=MountMode.READ),
            },
        )
    )
    # The set is one list for the whole session, so a name pattern
    # written under a mount has to carry the mount with it: raw,
    # ``*.pem`` would hide ``/scratch/key.pem`` too.
    assert out.visibility.paths == HiddenPaths(
        paths=("/shared/finance", "/repo/.env"), patterns=("/repo/*.pem",)
    )
    assert not path_visible(out.visibility, "/repo/deep/key.pem")
    assert path_visible(out.visibility, "/scratch/key.pem")
    profile = compile_profile(
        SessionProfile(paths=PathsBlock(hide=("*.pem",)))
    )
    assert not path_visible(profile.visibility, "/scratch/key.pem")


def test_compile_profile_of_a_bare_or_absent_role_states_nothing():
    empty = compile_profile(None)
    assert (
        empty.policies.mount_modes,
        empty.visibility.paths,
        empty.visibility.vars,
        empty.setup.env,
        empty.setup.cwd,
        empty.policies.commands,
    ) == (None, None, None, None, None, None)
    assert compile_profile(SessionProfile()) == empty
    # A profile that names a mount without a mode narrows nothing: the
    # mount keeps whatever the workspace gave it.
    assert (
        compile_profile(
            SessionProfile(mounts={"/a": ProfileMount()})
        ).policies.mount_modes
        is None
    )


def test_narrow_stamps_the_uneditable_fields_and_apply_seeds_the_rest():
    compiled = compile_profile(
        SessionProfile(
            cwd="/a",
            env={"ROLE": "x"},
            mounts={"/a": "rw"},
            paths=PathsBlock(hide=("/a/secrets",)),
            vars=VarsBlock(hide=("SLACK_TOKEN",)),
        )
    )
    narrowed = SessionState(session_id="s1")
    narrow(narrowed, compiled)
    assert narrowed.mount_modes == {"/a": MountMode.WRITE}
    assert narrowed.mount_modes is not compiled.policies.mount_modes
    assert narrowed.visibility.paths == HiddenPaths(paths=("/a/secrets",))
    assert narrowed.visibility.vars == HiddenVars(names=("SLACK_TOKEN",))
    assert narrowed.cwd == "/" and "ROLE" not in narrowed.env
    applied = SessionState(session_id="s2")
    apply_profile(applied, compiled)
    assert applied.mount_modes == {"/a": MountMode.WRITE}
    assert applied.cwd == "/a"
    assert applied.env["ROLE"] == "x"
    assert VarAttr.EXPORT in applied.vars["ROLE"].attrs


def test_narrow_carries_the_profiles_trees_onto_the_session():
    doc = SessionProfile(commands={"*": "deny", "ls": "allow"})
    compiled = compile_profile(
        doc, commands=command_rules(doc, None, BUILTIN_GRAMMARS)
    )
    assert compiled.policies.commands is not None
    session = SessionState(session_id="s")
    narrow(session, compiled)
    assert session.commands == compiled.policies.commands


def test_the_process_list_scope_is_part_of_what_a_session_sees():
    seen = compile_profile(
        SessionProfile.model_validate({"processes": "workspace"})
    )
    assert seen.visibility.processes == "workspace"
    assert seen.policies.processes.list == "workspace"
    session = SessionState(session_id="s")
    narrow(session, seen)
    assert session.visibility.processes == "workspace"
    assert compile_profile(SessionProfile(cwd="/x")).visibility.processes == (
        "session"
    )


def test_compile_profile_layers_the_profile_s_processes_over_the_workspace_s():
    workspace = ProcessPermissions.model_validate(
        {"list": "workspace", "max": 4}
    )
    capped = compile_profile(
        SessionProfile.model_validate({"processes": {"max": 9}}),
        "",
        workspace,
    )
    assert capped.policies.processes == ProcessPermissions(
        list="workspace", max=9
    )
    assert capped.visibility.processes == "workspace"
    assert compile_profile(None, "", workspace).policies.processes == (
        ProcessPermissions(list="workspace", max=4)
    )
    assert compile_profile(None).policies.processes == ProcessPermissions()


def test_with_inline_narrows_the_workspace_s_processes_under_a_bare_profile():
    workspace = ProcessPermissions.model_validate({"max": 4})
    inline = SessionProfile.model_validate({"processes": {"max": 9}})
    merged = with_inline(SessionProfile(cwd="/x"), inline, workspace)
    assert merged is not None and merged.processes is not None
    assert merged.processes.max == 4
    assert compile_profile(merged, "", workspace).policies.processes.max == 4
    alone = with_inline(None, inline, workspace)
    assert alone is not None and alone.processes is not None
    assert alone.processes.max == 4


def test_with_inline_cannot_add_show_and_the_bases_survives():
    base = SessionProfile(
        paths=PathsBlock(
            hide=("/repo",),
            show=(ShowEntry(path="/repo/public", mode=None),),
            reasons=(HideReason(patterns=("/repo",), reason="sealed"),),
        )
    )
    inline = SessionProfile(
        paths=PathsBlock(
            hide=("/repo/extra",),
            reasons=(HideReason(patterns=("/repo/extra",), reason="audit"),),
        )
    )
    out = with_inline(base, inline)
    # The profile's show and both sides' reasons survive the merge.
    assert out.paths.show == base.paths.show
    assert out.paths.hide == ("/repo", "/repo/extra")
    assert out.paths.reasons == base.paths.reasons + inline.paths.reasons
    with pytest.raises(PolicyError, match="not show entries"):
        with_inline(
            base,
            SessionProfile(
                paths=PathsBlock(
                    show=(ShowEntry(path="/repo/secrets", mode=None),)
                )
            ),
        )
    # The mount-section spelling is the same statement.
    with pytest.raises(PolicyError, match="not show entries"):
        with_inline(
            base,
            SessionProfile(
                mounts={
                    "/repo": ProfileMount(
                        paths=PathsBlock(
                            show=(ShowEntry(path="/repo/secrets", mode=None),)
                        )
                    )
                }
            ),
        )
    # And with no profile to add to, the same rule.
    with pytest.raises(PolicyError, match="not show entries"):
        with_inline(
            None,
            SessionProfile(
                paths=PathsBlock(show=(ShowEntry(path="/x", mode=None),))
            ),
        )


def test_with_inline_keeps_a_mount_sections_show():
    base = SessionProfile(
        mounts={
            "/repo": ProfileMount(
                paths=PathsBlock(
                    hide=("/repo",),
                    show=(
                        ShowEntry(path="/repo/public", mode=MountMode.READ),
                    ),
                )
            )
        }
    )
    inline = SessionProfile(
        mounts={"/repo": ProfileMount(paths=PathsBlock(hide=("/repo/extra",)))}
    )
    entry = with_inline(base, inline).mounts["/repo"]
    assert entry.paths.show == (
        ShowEntry(path="/repo/public", mode=MountMode.READ),
    )
    assert entry.paths.hide == ("/repo", "/repo/extra")


def test_compile_profile_collects_the_shows_of_every_mount_section():
    out = compile_profile(
        SessionProfile(
            paths=PathsBlock(
                hide=("/repo",),
                show=(ShowEntry(path="/repo/public", mode=None),),
            ),
            mounts={
                "/data": ProfileMount(
                    paths=PathsBlock(
                        hide=("/data",),
                        show=(
                            ShowEntry(path="/data/out", mode=MountMode.WRITE),
                        ),
                    )
                )
            },
        )
    )
    assert out.visibility.shown == ShownPaths(
        entries=(
            ShowEntry(path="/repo/public", mode=None),
            ShowEntry(path="/data/out", mode=MountMode.WRITE),
        )
    )
    # The axis reads them together: the show reopens its subtree.
    assert path_visible(out.visibility, "/repo/public/a")
    assert not path_visible(out.visibility, "/repo/x")


def test_compile_profile_anchors_a_mount_sections_reasons():
    out = compile_profile(
        SessionProfile(
            paths=PathsBlock(
                reasons=(HideReason(patterns=("/shared",), reason="global"),)
            ),
            mounts={
                "/repo": ProfileMount(
                    paths=PathsBlock(
                        reasons=(
                            HideReason(
                                patterns=("*.pem",), reason="credentials"
                            ),
                        )
                    )
                )
            },
        )
    )
    assert out.hide_reasons == (
        HideReason(patterns=("/shared",), reason="global"),
        HideReason(patterns=("/repo/*.pem",), reason="credentials"),
    )


def test_narrow_stamps_the_path_axis():
    compiled = compile_profile(
        SessionProfile(
            paths=PathsBlock(
                hide=("/repo",),
                show=(ShowEntry(path="/repo/public", mode=None),),
                reasons=(HideReason(patterns=("/repo",), reason="sealed"),),
            )
        )
    )
    session = SessionState(session_id="s")
    narrow(session, compiled)
    assert session.visibility.shown == compiled.visibility.shown
    assert session.hide_reasons == compiled.hide_reasons
    empty = compile_profile(None)
    assert empty.visibility.shown is None and empty.hide_reasons == ()


def test_compile_profile_carries_the_name_and_narrow_stamps_it():
    compiled = compile_profile(PROFILES["reviewer"], "reviewer")
    assert compiled.profile == "reviewer"
    session = SessionState(session_id="s1")
    narrow(session, compiled)
    assert session.profile == "reviewer"
    # A document passed without a name, and no document at all, leave
    # the session with no profile to report.
    assert compile_profile(PROFILES["reviewer"]).profile is None
    assert compile_profile(None).profile is None
    narrow(session, compile_profile(None))
    assert session.profile is None
