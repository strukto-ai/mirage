import pytest

from mirage.policy.errors import PolicyError
from mirage.policy.match.rule import match_op, rule_scope
from mirage.policy.types import (AdmissionRules, CommandRule, HideReason,
                                 OpsContext)
from mirage.shell.variable import VarAttr
from mirage.types import (HiddenPaths, HiddenVars, MountMode, PathSpec,
                          ShowEntry, ShownPaths)
from mirage.utils.hidden import path_hidden, path_visible
from mirage.workspace.session.session import Session

from mirage.policy.profile import (  # isort: skip
    CommandsBlock, MountCommandsBlock, PathsBlock, ProfileMount,
    SessionProfile, VarsBlock)
from mirage.workspace.session.resolve import (  # isort: skip
    apply_profile, compile_commands, compile_profile, narrow, resolve_profile,
    with_inline)

PROFILES = {
    "default":
    SessionProfile(cwd="/scratch",
                   env={"PAGER": "cat"},
                   mounts={
                       "/repo": "r",
                       "/scratch": "rwx"
                   }),
    "reviewer":
    SessionProfile(paths=PathsBlock(hide=("/repo/.env", )),
                   env={"ROLE": "reviewer"}),
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
    base = SessionProfile(cwd="/scratch",
                          env={
                              "PAGER": "cat",
                              "A": "1"
                          },
                          paths=PathsBlock(hide=("/repo/.env", "*.pem")),
                          vars=VarsBlock(hide=("AWS_*", )))
    inline = SessionProfile(cwd="/repo",
                            env={"A": "2"},
                            paths=PathsBlock(hide=("*.pem", "/repo/secrets")),
                            vars=VarsBlock(hide=("SLACK_TOKEN", )))
    out = with_inline(base, inline)
    assert out is not None
    assert out.cwd == "/repo"
    assert out.env == {"PAGER": "cat", "A": "2"}
    assert out.paths == PathsBlock(hide=("/repo/.env", "*.pem",
                                         "/repo/secrets"))
    assert out.vars == VarsBlock(hide=("AWS_*", "SLACK_TOKEN"))


def test_with_inline_merges_one_mount_section():
    base = SessionProfile(
        mounts={
            "/repo":
            ProfileMount(mode=MountMode.WRITE,
                         commands=MountCommandsBlock(deny=("rm", )),
                         paths=PathsBlock(hide=("/repo/.env", )))
        })
    inline = SessionProfile(
        mounts={
            "/repo":
            ProfileMount(commands=MountCommandsBlock(ask=("git push", )),
                         paths=PathsBlock(hide=("/repo/secrets", )))
        })
    entry = with_inline(base, inline).mounts["/repo"]
    assert entry.mode is MountMode.WRITE
    assert entry.commands is not None
    assert [r.commands for r in entry.commands.deny] == [("rm", )]
    assert [r.commands for r in entry.commands.ask] == [("git push", )]
    assert entry.paths == PathsBlock(hide=("/repo/.env", "/repo/secrets"))


def test_with_inline_with_one_side_missing_is_the_other():
    p = SessionProfile(cwd="/x")
    assert with_inline(None, p) is p
    assert with_inline(p, None) is p
    assert with_inline(None, None) is None


def test_with_inline_adds_ask_and_deny_but_refuses_an_allow_list():
    base = SessionProfile(commands=CommandsBlock(
        allow=("ls", "git", "cat"), ask=("git push", ), deny=("rm", )))
    inline = SessionProfile(commands=CommandsBlock(
        deny=(CommandRule(reason="no", commands=("mv", )), )))
    out = with_inline(base, inline)
    assert out is not None and out.commands is not None
    # The allow list is the profile's alone, and the added rules land after
    # it: an inline document restricts, it never installs.
    assert out.commands.allow == ("ls", "git", "cat")
    assert [r.commands for r in out.commands.ask] == [("git push", )]
    assert [r.commands for r in out.commands.deny] == [("rm", ), ("mv", )]
    with pytest.raises(PolicyError, match="not an allow list"):
        with_inline(base,
                    SessionProfile(commands=CommandsBlock(allow=("wc", ))))
    # And with no profile to add to: the refusal belongs to where the
    # document was written, so a workspace that happens to declare no
    # default profile must not quietly accept what one with a profile refuses.
    with pytest.raises(PolicyError, match="not an allow list"):
        with_inline(None,
                    SessionProfile(commands=CommandsBlock(allow=("wc", ))))


def test_with_inline_leaves_a_stated_block_alone_when_the_other_is_bare():
    base = SessionProfile(commands=CommandsBlock(allow=("ls", )))
    assert with_inline(base,
                       SessionProfile(cwd="/x")).commands == (base.commands)
    inline = SessionProfile(commands=CommandsBlock(deny=("rm", )))
    assert with_inline(SessionProfile(cwd="/x"),
                       inline).commands == inline.commands


def test_compile_commands_lists_mount_rules_before_the_role_s_own():
    rules = compile_commands(
        SessionProfile(
            commands=CommandsBlock(allow=("ls", ), deny=("shutdown", )),
            mounts={
                "/repo":
                ProfileMount(commands=MountCommandsBlock(
                    ask=("git rebase", ),
                    deny=(CommandRule(reason="ro",
                                      commands=("rm", ),
                                      paths=("/repo/*.lock", )), ))),
                "/scratch":
                ProfileMount(mode=MountMode.READ),
            }))
    assert rules is not None
    assert rules.allow == ("ls", )
    # Every mount rule carries the root it was written under, which is
    # what scopes it to a line working inside that mount; its paths are
    # kept exactly as typed.
    assert rules.deny[0] == CommandRule(reason="ro",
                                        commands=("rm", ),
                                        paths=("/repo/*.lock", ),
                                        mount="/repo")
    assert rules.deny[1].commands == ("shutdown", ) and not rules.deny[1].mount
    assert rules.ask[0].commands == ("git rebase", )
    assert rules.ask[0].mount == "/repo" and not rules.ask[0].paths


def test_compile_commands_anchors_a_name_pattern_to_its_mount():
    rules = compile_commands(
        SessionProfile(
            mounts={
                "/repo":
                ProfileMount(commands=MountCommandsBlock(
                    deny=(CommandRule(reason="no pems", paths=("*.pem", )), )))
            }))
    assert rules is not None
    rule = rules.deny[0]
    assert rule.paths == ("/repo/*.pem", )
    # The stamp scopes the rule at admission, but the op door reads the
    # paths alone, so a raw name pattern refused a read in every other
    # mount too.
    scope = rule_scope(rule)
    assert match_op(rule, scope, _read_op("/repo/deep/key.pem"))
    assert not match_op(rule, scope, _read_op("/other/key.pem"))


def _read_op(virtual: str) -> OpsContext:
    return OpsContext(op="read",
                      path=PathSpec(virtual=virtual,
                                    directory=virtual.rsplit("/", 1)[0],
                                    resource_path=virtual,
                                    raw_path=virtual),
                      write=False,
                      prefix="/other")


def test_compile_commands_is_none_when_the_role_states_no_rules():
    assert compile_commands(SessionProfile()) is None
    assert compile_commands(SessionProfile(commands=CommandsBlock())) is None
    assert compile_commands(
        SessionProfile(mounts={"/repo": ProfileMount(
            mode=MountMode.READ)})) is None


def test_compile_profile_turns_the_document_into_session_fields():
    out = compile_profile(
        SessionProfile(cwd="/scratch",
                       env={"ROLE": "x"},
                       mounts={
                           "/a": "rw",
                           "/b": "r"
                       },
                       paths=PathsBlock(hide=("/a/secrets", "*.key")),
                       vars=VarsBlock(hide=("SLACK_TOKEN", "AWS_*"))))
    assert out.mount_modes == {"/a": MountMode.WRITE, "/b": MountMode.READ}
    assert out.hidden_paths == HiddenPaths(paths=("/a/secrets", ),
                                           patterns=("*.key", ))
    assert out.hidden_vars == HiddenVars(names=("SLACK_TOKEN", ),
                                         patterns=("AWS_*", ))
    assert out.env == {"ROLE": "x"}
    assert out.cwd == "/scratch"


def test_compile_profile_collects_the_hides_of_every_mount_section():
    out = compile_profile(
        SessionProfile(paths=PathsBlock(hide=("/shared/finance", )),
                       mounts={
                           "/repo":
                           ProfileMount(paths=PathsBlock(hide=("/repo/.env",
                                                               "*.pem"))),
                           "/scratch":
                           ProfileMount(mode=MountMode.READ),
                       }))
    # The set is one list for the whole session, so a name pattern
    # written under a mount has to carry the mount with it: raw,
    # ``*.pem`` would hide ``/scratch/key.pem`` too.
    assert out.hidden_paths == HiddenPaths(paths=("/shared/finance",
                                                  "/repo/.env"),
                                           patterns=("/repo/*.pem", ))
    assert path_hidden(out.hidden_paths, "/repo/deep/key.pem")
    assert not path_hidden(out.hidden_paths, "/scratch/key.pem")
    profile = compile_profile(
        SessionProfile(paths=PathsBlock(hide=("*.pem", ))))
    assert path_hidden(profile.hidden_paths, "/scratch/key.pem")


def test_compile_profile_of_a_bare_or_absent_role_states_nothing():
    empty = compile_profile(None)
    assert (empty.mount_modes, empty.hidden_paths, empty.hidden_vars,
            empty.env, empty.cwd, empty.commands) == (None, None, None, None,
                                                      None, None)
    assert compile_profile(SessionProfile()) == empty
    # A profile that names a mount without a mode narrows nothing: the
    # mount keeps whatever the workspace gave it.
    assert compile_profile(
        SessionProfile(mounts={"/a": ProfileMount()})).mount_modes is None


def test_narrow_stamps_the_uneditable_fields_and_apply_seeds_the_rest():
    compiled = compile_profile(
        SessionProfile(cwd="/a",
                       env={"ROLE": "x"},
                       mounts={"/a": "rw"},
                       paths=PathsBlock(hide=("/a/secrets", )),
                       vars=VarsBlock(hide=("SLACK_TOKEN", ))))
    narrowed = Session(session_id="s1")
    narrow(narrowed, compiled)
    assert narrowed.mount_modes == {"/a": MountMode.WRITE}
    assert narrowed.mount_modes is not compiled.mount_modes
    assert narrowed.hidden_paths == HiddenPaths(paths=("/a/secrets", ))
    assert narrowed.hidden_vars == HiddenVars(names=("SLACK_TOKEN", ))
    assert narrowed.cwd == "/" and "ROLE" not in narrowed.env
    applied = Session(session_id="s2")
    apply_profile(applied, compiled)
    assert applied.mount_modes == {"/a": MountMode.WRITE}
    assert applied.cwd == "/a"
    assert applied.env["ROLE"] == "x"
    assert VarAttr.EXPORT in applied.vars["ROLE"].attrs


def test_narrow_carries_the_role_s_admission_rules_onto_the_session():
    compiled = compile_profile(
        SessionProfile(commands=CommandsBlock(allow=("ls", ), ask=("git", ))))
    assert compiled.commands == AdmissionRules(
        allow=("ls", ),
        ask=(CommandRule(reason="no standing approval", commands=("git", )), ))
    session = Session(session_id="s")
    narrow(session, compiled)
    assert session.commands == compiled.commands
    assert compile_profile(SessionProfile(cwd="/x")).commands is None


def test_with_inline_cannot_add_show_and_the_bases_survives():
    base = SessionProfile(paths=PathsBlock(
        hide=("/repo", ),
        show=(ShowEntry(path="/repo/public", mode=None), ),
        reasons=(HideReason(patterns=("/repo", ), reason="sealed"), )))
    inline = SessionProfile(paths=PathsBlock(
        hide=("/repo/extra", ),
        reasons=(HideReason(patterns=("/repo/extra", ), reason="audit"), )))
    out = with_inline(base, inline)
    # The profile's show and both sides' reasons survive the merge.
    assert out.paths.show == base.paths.show
    assert out.paths.hide == ("/repo", "/repo/extra")
    assert out.paths.reasons == base.paths.reasons + inline.paths.reasons
    with pytest.raises(PolicyError, match="not show entries"):
        with_inline(
            base,
            SessionProfile(paths=PathsBlock(
                show=(ShowEntry(path="/repo/secrets", mode=None), ))))
    # The mount-section spelling is the same statement.
    with pytest.raises(PolicyError, match="not show entries"):
        with_inline(
            base,
            SessionProfile(
                mounts={
                    "/repo":
                    ProfileMount(paths=PathsBlock(
                        show=(ShowEntry(path="/repo/secrets", mode=None), )))
                }))
    # And with no profile to add to, same rule as the allow list.
    with pytest.raises(PolicyError, match="not show entries"):
        with_inline(
            None,
            SessionProfile(paths=PathsBlock(
                show=(ShowEntry(path="/x", mode=None), ))))


def test_with_inline_keeps_a_mount_sections_show():
    base = SessionProfile(
        mounts={
            "/repo":
            ProfileMount(paths=PathsBlock(
                hide=("/repo", ),
                show=(ShowEntry(path="/repo/public", mode=MountMode.READ), )))
        })
    inline = SessionProfile(
        mounts={
            "/repo": ProfileMount(paths=PathsBlock(hide=("/repo/extra", )))
        })
    entry = with_inline(base, inline).mounts["/repo"]
    assert entry.paths.show == (ShowEntry(path="/repo/public",
                                          mode=MountMode.READ), )
    assert entry.paths.hide == ("/repo", "/repo/extra")


def test_compile_profile_collects_the_shows_of_every_mount_section():
    out = compile_profile(
        SessionProfile(
            paths=PathsBlock(hide=("/repo", ),
                             show=(ShowEntry(path="/repo/public",
                                             mode=None), )),
            mounts={
                "/data":
                ProfileMount(
                    paths=PathsBlock(hide=("/data", ),
                                     show=(ShowEntry(path="/data/out",
                                                     mode=MountMode.WRITE), )))
            }))
    assert out.shown_paths == ShownPaths(
        entries=(ShowEntry(path="/repo/public", mode=None),
                 ShowEntry(path="/data/out", mode=MountMode.WRITE)))
    # The axis reads them together: the show reopens its subtree.
    assert path_visible(out.hidden_paths, out.shown_paths, "/repo/public/a")
    assert not path_visible(out.hidden_paths, out.shown_paths, "/repo/x")


def test_compile_profile_anchors_a_mount_sections_reasons():
    out = compile_profile(
        SessionProfile(
            paths=PathsBlock(reasons=(
                HideReason(patterns=("/shared", ), reason="global"), )),
            mounts={
                "/repo":
                ProfileMount(paths=PathsBlock(reasons=(
                    HideReason(patterns=("*.pem", ), reason="credentials"), )))
            }))
    assert out.hide_reasons == (
        HideReason(patterns=("/shared", ), reason="global"),
        HideReason(patterns=("/repo/*.pem", ), reason="credentials"),
    )


def test_narrow_stamps_the_path_axis():
    compiled = compile_profile(
        SessionProfile(paths=PathsBlock(
            hide=("/repo", ),
            show=(ShowEntry(path="/repo/public", mode=None), ),
            reasons=(HideReason(patterns=("/repo", ), reason="sealed"), ))))
    session = Session(session_id="s")
    narrow(session, compiled)
    assert session.shown_paths == compiled.shown_paths
    assert session.hide_reasons == compiled.hide_reasons
    empty = compile_profile(None)
    assert empty.shown_paths is None and empty.hide_reasons == ()


def test_compile_profile_carries_the_name_and_narrow_stamps_it():
    compiled = compile_profile(PROFILES["reviewer"], "reviewer")
    assert compiled.profile == "reviewer"
    session = Session(session_id="s1")
    narrow(session, compiled)
    assert session.profile == "reviewer"
    # A document passed without a name, and no document at all, leave
    # the session with no profile to report.
    assert compile_profile(PROFILES["reviewer"]).profile is None
    assert compile_profile(None).profile is None
    narrow(session, compile_profile(None))
    assert session.profile is None
