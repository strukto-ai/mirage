import pytest

from mirage.policy.errors import PolicyError
from mirage.policy.match.decide import decide
from mirage.policy.match.rule import match_op, rule_scope
from mirage.policy.types import (AdmissionRules, CommandContext, CommandRule,
                                 HideReason, OpsContext, Outcome)
from mirage.shell.variable import VarAttr
from mirage.types import (HiddenPaths, HiddenVars, MountMode, PathSpec,
                          ShowEntry, ShownPaths)
from mirage.utils.hidden import path_hidden, path_visible
from mirage.workspace.session.session import Session

from mirage.policy.profile import (  # isort: skip
    CommandsBlock, MountCommandsBlock, PathsBlock, ProfileMount,
    SessionProfile, VarsBlock)
from mirage.workspace.session.resolve import (  # isort: skip
    apply_profile, compile_commands, compile_profile, narrow, narrow_profile,
    narrow_restored, narrowing_of, resolve_profile, with_inline)

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


def _restored(**fields) -> Session:
    return Session(session_id="table", **fields)


def test_narrow_restored_takes_the_weaker_mode_over_both_key_sets():
    session = Session(session_id="s", mount_modes={"/a": MountMode.WRITE})
    narrow_restored(
        session,
        _restored(mount_modes={
            "/a/": MountMode.READ,
            "b": MountMode.EXEC
        }))
    assert session.mount_modes == {"/a": MountMode.READ, "/b": MountMode.EXEC}
    # A table narrowing nothing leaves the session's own map in place.
    modes = session.mount_modes
    narrow_restored(session, _restored(mount_modes={"/a": MountMode.EXEC}))
    assert session.mount_modes is modes


def test_narrow_restored_unions_hides_in_order_without_repeats():
    session = Session(session_id="s",
                      hidden_paths=HiddenPaths(paths=("/x", ),
                                               patterns=("*.pem", )),
                      hidden_vars=HiddenVars(names=("A", )),
                      hide_reasons=(HideReason(patterns=("/x", ),
                                               reason="sealed"), ))
    narrow_restored(
        session,
        _restored(hidden_paths=HiddenPaths(paths=("/y", "/x"),
                                           patterns=("*.key", "*.pem")),
                  hidden_vars=HiddenVars(names=("A", "B"),
                                         patterns=("AWS_*", )),
                  hide_reasons=(HideReason(patterns=("/x", ), reason="sealed"),
                                HideReason(patterns=("/y", ),
                                           reason="private"))))
    assert session.hidden_paths == HiddenPaths(paths=("/x", "/y"),
                                               patterns=("*.pem", "*.key"))
    assert session.hidden_vars == HiddenVars(names=("A", "B"),
                                             patterns=("AWS_*", ))
    assert session.hide_reasons == (HideReason(patterns=("/x", ),
                                               reason="sealed"),
                                    HideReason(patterns=("/y", ),
                                               reason="private"))
    # One side stating nothing takes the other's spec as it is.
    bare = Session(session_id="bare")
    narrow_restored(bare, _restored(hidden_vars=HiddenVars(names=("T", ))))
    assert bare.hidden_vars == HiddenVars(names=("T", ))
    assert bare.hidden_paths is None


def test_narrow_restored_intersects_allow_lists_and_appends_rules():
    deny_rm = CommandRule(reason="no", commands=("rm", ))
    deny_mv = CommandRule(reason="no", commands=("mv", ))
    session = Session(session_id="s",
                      commands=AdmissionRules(allow=("git *", "cat"),
                                              deny=(deny_rm, )))
    narrow_restored(
        session,
        _restored(commands=AdmissionRules(
            allow=("git push", "cat", "ls"),
            ask=(CommandRule(reason="ask", commands=("git", )), ),
            deny=(deny_rm, deny_mv))))
    assert session.commands == AdmissionRules(allow=("git push", "cat"),
                                              ask=(CommandRule(
                                                  reason="ask",
                                                  commands=("git", )), ),
                                              deny=(deny_rm, deny_mv))
    # A list only one side states stands: it installs only what it lists.
    one = Session(session_id="one")
    narrow_restored(one, _restored(commands=AdmissionRules(allow=("ls", ))))
    assert one.commands == AdmissionRules(allow=("ls", ))
    other = Session(session_id="other",
                    commands=AdmissionRules(allow=("ls", )))
    narrow_restored(other,
                    _restored(commands=AdmissionRules(deny=(deny_rm, ))))
    assert other.commands == AdmissionRules(allow=("ls", ), deny=(deny_rm, ))


def test_narrow_restored_keeps_a_show_only_as_both_sides_allow_it():
    session = Session(
        session_id="s",
        mount_modes={"/repo": MountMode.READ},
        hidden_paths=HiddenPaths(paths=("/repo/sealed", )),
        shown_paths=ShownPaths(entries=(
            ShowEntry(path="/repo/sealed/public", mode=None),
            ShowEntry(path="/repo/sealed/docs", mode=MountMode.WRITE),
            ShowEntry(path="/repo/build", mode=None),
        )))
    narrow_restored(
        session,
        _restored(shown_paths=ShownPaths(entries=(
            ShowEntry(path="/repo/sealed/public", mode=None),
            ShowEntry(path="/repo/sealed/docs", mode=MountMode.READ),
            ShowEntry(path="/repo/sealed/other", mode=None),
            ShowEntry(path="/repo/out", mode=MountMode.EXEC),
        ))))
    assert session.shown_paths == ShownPaths(entries=(
        # Both state it, neither with a mode: list-form on both sides.
        ShowEntry(path="/repo/sealed/public", mode=None),
        # Both state a mode: the weaker.
        ShowEntry(path="/repo/sealed/docs", mode=MountMode.READ),
        # Only the session states it and nothing hides it: kept.
        ShowEntry(path="/repo/build", mode=None),
        # Only the table states it, nothing hides it, and its mode is
        # held under the session's cap at /repo.
        ShowEntry(path="/repo/out", mode=MountMode.READ),
        # /repo/sealed/other, only the table's, re-opens a hidden
        # subtree and is dropped.
    ))


def test_narrow_restored_is_the_identity_for_a_table_from_the_same_document():
    compiled = compile_profile(
        SessionProfile(mounts={
            "/repo":
            ProfileMount(mode=MountMode.WRITE,
                         paths=PathsBlock(hide=("/repo/sealed", ),
                                          show={"/repo/sealed/public": "r"},
                                          reasons=(HideReason(
                                              patterns=("/repo/sealed", ),
                                              reason="sealed"), )),
                         commands=MountCommandsBlock(ask=("git push", )))
        },
                       vars=VarsBlock(hide=("AWS_*", )),
                       commands=CommandsBlock(allow=("git *", "ls", "rm"),
                                              deny=("rm", ))), "named")
    session = Session(session_id="s")
    narrow(session, compiled)
    table = Session.from_dict(session.to_dict())
    narrow_restored(session, table)
    assert session.commands is compiled.commands
    assert session.hidden_paths is compiled.hidden_paths
    assert session.hidden_vars is compiled.hidden_vars
    assert session.shown_paths is compiled.shown_paths
    assert session.hide_reasons is compiled.hide_reasons
    assert session.mount_modes == compiled.mount_modes
    assert session.to_dict() == table.to_dict()


def test_narrow_restored_keeps_the_sessions_program_and_name():
    target = compile_profile(SessionProfile(cwd="/x"), "target")
    session = Session(session_id="s")
    narrow(session, target)
    table = Session(session_id="s",
                    profile="other",
                    commands=AdmissionRules(
                        deny=(CommandRule(reason="no", commands=("rm", )), )))
    narrow_restored(session, table)
    assert session.profile == "target"
    assert session.script is target.script
    assert session.commands == table.commands


# A show is always stated against a hide, so reading the merged hide set
# dropped every one-sided show under its own side's hide: a table that
# simply never mentioned /vault took /vault/public away with it.
def test_narrow_restored_keeps_a_one_sided_show_under_its_own_hide():
    session = Session(
        session_id="s",
        hidden_paths=HiddenPaths(paths=("/vault", )),
        shown_paths=ShownPaths(
            entries=(ShowEntry(path="/vault/public", mode=None), )))
    narrow_restored(session, _restored())
    assert session.shown_paths == ShownPaths(
        entries=(ShowEntry(path="/vault/public", mode=None), ))
    assert path_visible(session.hidden_paths, session.shown_paths,
                        "/vault/public")
    # The same either way round: the table's show under the table's own
    # hide survives an unrestricted session.
    other = Session(session_id="s")
    narrow_restored(
        other,
        _restored(hidden_paths=HiddenPaths(paths=("/vault", )),
                  shown_paths=ShownPaths(
                      entries=(ShowEntry(path="/vault/public", mode=None), ))))
    assert other.shown_paths == ShownPaths(
        entries=(ShowEntry(path="/vault/public", mode=None), ))


# A pattern show is the same case: dropped only where the other side
# hides at all, since no comparison proves which names it leaves open.
def test_narrow_restored_keeps_a_one_sided_pattern_show_when_nothing_hides():
    session = Session(
        session_id="s",
        hidden_paths=HiddenPaths(paths=("/work/aaa", )),
        shown_paths=ShownPaths(
            entries=(ShowEntry(path="/work/aaa/*.txt", mode=None), )))
    narrow_restored(session, _restored())
    assert session.shown_paths == ShownPaths(
        entries=(ShowEntry(path="/work/aaa/*.txt", mode=None), ))
    hidden = Session(
        session_id="s",
        hidden_paths=HiddenPaths(paths=("/work/aaa", )),
        shown_paths=ShownPaths(
            entries=(ShowEntry(path="/work/aaa/*.txt", mode=None), )))
    narrow_restored(hidden,
                    _restored(hidden_paths=HiddenPaths(paths=("/work", ))))
    assert hidden.shown_paths is None


def test_narrow_profile_joins_restrictions_onto_a_live_session():
    session = Session(session_id="s",
                      mount_modes={"/repo": MountMode.WRITE},
                      hidden_paths=HiddenPaths(paths=("/repo/live", )))
    narrow_profile(
        session,
        compile_profile(
            SessionProfile(mounts={"/repo": "r"},
                           paths=PathsBlock(hide=("/repo/sealed", )),
                           commands=CommandsBlock(deny=("rm", ))), "named"))
    assert session.mount_modes == {"/repo": MountMode.READ}
    assert path_hidden(session.hidden_paths, "/repo/live")
    assert path_hidden(session.hidden_paths, "/repo/sealed")
    assert session.profile == "named"


# A program the host installed with set_session_profile is the host's,
# and a restore only adds restrictions: the name travels with it, so a
# session never reports a group whose script it is not running.
def test_narrow_profile_keeps_a_program_the_session_already_runs():
    running = compile_profile(
        SessionProfile(
            policy={
                "script": {
                    "source": "def pre_command(ctx):\n    return None\n",
                    "language": "python",
                },
                "runtime": "monty",
            }), "locked")
    session = Session(session_id="s")
    narrow(session, running)
    narrow_profile(session, compile_profile(SessionProfile(cwd="/x"),
                                            "wanted"))
    assert session.script is running.script
    assert session.profile == "locked"


def test_narrow_profile_takes_the_program_of_a_session_running_none():
    wanted = compile_profile(
        SessionProfile(
            policy={
                "script": {
                    "source": "def pre_command(ctx):\n    return None\n",
                    "language": "python",
                },
                "runtime": "monty",
            }), "wanted")
    session = Session(session_id="s")
    narrow_profile(session, wanted)
    assert session.script is wanted.script
    assert session.profile == "wanted"


def test_narrowing_of_round_trips_through_narrow():
    compiled = compile_profile(
        SessionProfile(mounts={"/repo": "r"},
                       paths=PathsBlock(hide=("/repo/sealed", ),
                                        show={"/repo/sealed/public": "r"}),
                       vars=VarsBlock(hide=("AWS_*", )),
                       commands=CommandsBlock(deny=("rm", ))), "named")
    session = Session(session_id="s")
    narrow(session, compiled)
    before = session.to_dict()
    saved = narrowing_of(session)
    narrow_profile(
        session,
        compile_profile(
            SessionProfile(mounts={"/repo": "rwx"},
                           paths=PathsBlock(hide=("/other", ))), "wider"))
    assert session.to_dict() != before
    narrow(session, saved)
    assert session.to_dict() == before


# Both sides hide /vault and both reach /vault/public/docs, one through
# a broad carve-out and one through a narrow one. An exact-path lookup
# found no counterpart for either entry, so each was judged one-sided
# and dropped against the other side's /vault hide, and the subtree both
# sides permit came back inaccessible. A grant is a depth comparison,
# not a string match: the narrower carve-out is the intersection.
def test_narrow_restored_keeps_a_nested_show_both_sides_reach():
    session = Session(
        session_id="s",
        hidden_paths=HiddenPaths(paths=("/vault", )),
        shown_paths=ShownPaths(
            entries=(ShowEntry(path="/vault/public", mode=None), )))
    narrow_restored(
        session,
        _restored(
            hidden_paths=HiddenPaths(paths=("/vault", )),
            shown_paths=ShownPaths(
                entries=(ShowEntry(path="/vault/public/docs", mode=None), ))))
    assert session.shown_paths == ShownPaths(
        entries=(ShowEntry(path="/vault/public/docs", mode=None), ))
    assert path_visible(session.hidden_paths, session.shown_paths,
                        "/vault/public/docs")
    # Only the narrower grant survives: the broad one is not the
    # table's, and its siblings stay sealed.
    assert not path_visible(session.hidden_paths, session.shown_paths,
                            "/vault/public/other")


# The mode travels with the nesting: a narrow carve-out is held under
# what the broad one allows above it, since a show scores deeper than a
# per-mount cap and would otherwise lift it.
def test_narrow_restored_holds_a_nested_show_under_the_broader_mode():
    session = Session(
        session_id="s",
        hidden_paths=HiddenPaths(paths=("/vault", )),
        shown_paths=ShownPaths(
            entries=(ShowEntry(path="/vault/public", mode=MountMode.READ), )))
    narrow_restored(
        session,
        _restored(hidden_paths=HiddenPaths(paths=("/vault", )),
                  shown_paths=ShownPaths(entries=(ShowEntry(
                      path="/vault/public/docs", mode=MountMode.WRITE), ))))
    assert session.shown_paths == ShownPaths(
        entries=(ShowEntry(path="/vault/public/docs", mode=MountMode.READ), ))


def _ruled(doc: dict, name: str) -> Session:
    """A session narrowed under one profile document."""
    session = Session(session_id=name)
    narrow(session, compile_profile(SessionProfile.model_validate(doc), name))
    return session


class _Registry:

    def is_mount_root(self, path: str) -> bool:
        return False


def _path(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual.rsplit("/", 1)[0] or "/",
                    resource_path=virtual,
                    resolved=True,
                    raw_path=virtual)


def _ctx(command: str, *paths: str, words: tuple[str,
                                                 ...] = ()) -> CommandContext:
    """One classified line, the way the door hands it to the law."""
    specs = tuple(_path(p) for p in paths)
    return CommandContext(command=command,
                          paths=specs,
                          operands=specs,
                          argv=(*words, *paths),
                          cwd="/",
                          registry=_Registry(),
                          tokens=(command, *words, *paths))


def _answer(session: Session,
            command: str,
            *paths: str,
            words: tuple[str, ...] = ()) -> Outcome:
    """What the session's joined rules say about one line."""
    return decide(_ctx(command, *paths, words=words), session.commands).outcome


# `rule_at` reads competing rules by anchor depth, deny before ask only
# at equal depth, so concatenating the two lists let a deeper ask from
# the table outrank a shallower deny on the session: a target refusing
# `cat /vault/*` answered a table asking `cat /vault/public/*` with a
# prompt. A deny from either side has to stay a deny.
def test_narrow_restored_keeps_a_deny_a_deeper_ask_would_outrank():
    session = _ruled(
        {
            "commands": {
                "allow": ["cat", "echo"],
                "deny": [{
                    "reason": "vault is sealed",
                    "commands": {
                        "cat": ["/vault/*"]
                    }
                }],
            }
        }, "target")
    table = _ruled(
        {
            "commands": {
                "allow": ["cat", "echo"],
                "ask": [{
                    "reason": "public needs a nod",
                    "commands": {
                        "cat": ["/vault/public/*"]
                    }
                }],
            }
        }, "source")
    narrow_restored(session, table)
    assert session.commands is not None
    # The deny is restated at the table entry's own depth, where the
    # verb tie-break lets the refusal win, carrying its own reason; the
    # ask stays whole.
    assert [(r.reason, r.paths) for r in session.commands.deny] == [
        ("vault is sealed", ("/vault/*", )),
        ("vault is sealed", ("/vault/public/*", )),
    ]
    assert [(r.reason, r.paths) for r in session.commands.ask
            ] == [("public needs a nod", ("/vault/public/*", ))]
    assert _answer(session, "cat", "/vault/public/x") is Outcome.DENY


# Only the covered part moves: a carve-out the other side never spoke
# about is still a question, not a refusal and not a grant.
def test_narrow_restored_curbs_only_what_the_other_side_denies():
    session = _ruled(
        {
            "commands": {
                "allow": ["cat", "echo"],
                "deny": [{
                    "reason": "vault is sealed",
                    "commands": {
                        "cat": ["/vault/*"]
                    }
                }],
            }
        }, "target")
    table = _ruled(
        {
            "commands": {
                "allow": ["cat", "echo"],
                "ask": [{
                    "reason": "a nod, please",
                    "commands": {
                        "cat": ["/vault/public/*", "/notes/*"]
                    }
                }],
            }
        }, "source")
    narrow_restored(session, table)
    assert session.commands is not None
    assert [(r.reason, r.paths) for r in session.commands.ask
            ] == [("a nod, please", ("/vault/public/*", "/notes/*"))]
    assert [(r.reason, r.paths) for r in session.commands.deny] == [
        ("vault is sealed", ("/vault/*", )),
        ("vault is sealed", ("/vault/public/*", )),
    ]
    assert _answer(session, "cat", "/vault/public/x") is Outcome.DENY
    assert _answer(session, "cat", "/notes/x") is Outcome.ASK


# A deny deeper than the ask already wins on its own subtree and must
# not swallow the shallower question above it.
def test_narrow_restored_leaves_an_ask_a_deeper_deny_already_outranks():
    session = _ruled(
        {
            "commands": {
                "allow": ["cat", "echo"],
                "deny": [{
                    "reason": "the key is sealed",
                    "commands": {
                        "cat": ["/vault/public/key/*"]
                    }
                }],
            }
        }, "target")
    table = _ruled(
        {
            "commands": {
                "allow": ["cat", "echo"],
                "ask": [{
                    "reason": "a nod, please",
                    "commands": {
                        "cat": ["/vault/*"]
                    }
                }],
            }
        }, "source")
    narrow_restored(session, table)
    assert session.commands is not None
    assert [(r.reason, r.paths) for r in session.commands.ask
            ] == [("a nod, please", ("/vault/*", ))]
    assert [(r.reason, r.paths) for r in session.commands.deny
            ] == [("the key is sealed", ("/vault/public/key/*", ))]


# A deny about another command reaches nothing the ask names, and
# refusing there would refuse a line neither side refuses.
def test_narrow_restored_does_not_curb_across_commands():
    session = _ruled(
        {
            "commands": {
                "allow": ["cat", "rm", "echo"],
                "deny": [{
                    "reason": "vault is sealed",
                    "commands": {
                        "rm": ["/vault/*"]
                    }
                }],
            }
        }, "target")
    table = _ruled(
        {
            "commands": {
                "allow": ["cat", "rm", "echo"],
                "ask": [{
                    "reason": "a nod, please",
                    "commands": {
                        "cat": ["/vault/public/*"]
                    }
                }],
            }
        }, "source")
    narrow_restored(session, table)
    assert session.commands is not None
    assert [(r.reason, r.paths) for r in session.commands.ask
            ] == [("a nod, please", ("/vault/public/*", ))]
    assert [(r.reason, r.paths) for r in session.commands.deny
            ] == [("vault is sealed", ("/vault/*", ))]
    assert _answer(session, "cat", "/vault/public/x") is Outcome.ASK


# A deny written under a mount section applies only to lines working
# inside that mount, and a top-level ask applies everywhere, so the
# two overlap inside the mount: there the deeper ask outranked the
# deny and answered the refusal with a prompt. The deny is restated at
# the ask's depth, still scoped to its mount.
def test_narrow_restored_restates_a_mount_scoped_deny_inside_its_mount():
    session = _ruled(
        {
            "commands": {
                "allow": ["cat", "echo"]
            },
            "mounts": {
                "/vault": {
                    "commands": {
                        "deny": [{
                            "reason": "vault is sealed",
                            "commands": {
                                "cat": ["/vault/*"]
                            }
                        }]
                    }
                }
            },
        }, "target")
    table = _ruled(
        {
            "commands": {
                "allow": ["cat", "echo"],
                "ask": [{
                    "reason": "a nod, please",
                    "commands": {
                        "cat": ["/vault/public/*"]
                    }
                }],
            }
        }, "source")
    narrow_restored(session, table)
    assert session.commands is not None
    assert [
        (r.reason, r.commands, r.paths, r.mount) for r in session.commands.deny
    ] == [
        ("vault is sealed", ("cat", ), ("/vault/*", ), "/vault"),
        ("vault is sealed", ("cat", ), ("/vault/public/*", ), "/vault"),
    ]
    assert [(r.reason, r.paths) for r in session.commands.ask
            ] == [("a nod, please", ("/vault/public/*", ))]
    assert _answer(session, "cat", "/vault/public/x") is Outcome.DENY


# An ask naming paths alone speaks about every command, so it overlaps
# a `cat` deny on `cat` lines and nothing else: the deny is restated
# for `cat` at the ask's depth, and the other commands are still asked
# about, since neither side refused them.
def test_narrow_restored_restates_a_deny_for_the_commands_the_ask_shares():
    session = _ruled(
        {
            "commands": {
                "allow": ["cat", "rm", "echo"],
                "deny": [{
                    "reason": "vault is sealed",
                    "commands": {
                        "cat": ["/vault/*"]
                    }
                }],
            }
        }, "target")
    table = _ruled(
        {
            "commands": {
                "allow": ["cat", "rm", "echo"],
                "ask": [{
                    "reason": "a nod, please",
                    "paths": ["/vault/public/*"]
                }],
            }
        }, "source")
    narrow_restored(session, table)
    assert session.commands is not None
    assert [(r.reason, r.commands, r.paths)
            for r in session.commands.deny] == [
                ("vault is sealed", ("cat", ), ("/vault/*", )),
                ("vault is sealed", ("cat", ), ("/vault/public/*", )),
            ]
    assert [(r.reason, r.commands, r.paths) for r in session.commands.ask
            ] == [("a nod, please", (), ("/vault/public/*", ))]
    assert _answer(session, "cat", "/vault/public/x") is Outcome.DENY
    assert _answer(session, "rm", "/vault/public/x") is Outcome.ASK


# Two command patterns meet token by token: a `git` ask and a
# `git push` deny share `git push`, so the push is refused and every
# other git verb is still asked about.
def test_narrow_restored_restates_a_deny_at_the_verb_the_ask_shares():
    session = _ruled(
        {
            "commands": {
                "allow": ["git", "echo"],
                "deny": [{
                    "reason": "no pushing from the vault",
                    "commands": {
                        "git push": ["/vault/*"]
                    }
                }],
            }
        }, "target")
    table = _ruled(
        {
            "commands": {
                "allow": ["git", "echo"],
                "ask": [{
                    "reason": "a nod, please",
                    "commands": {
                        "git": ["/vault/public/*"]
                    }
                }],
            }
        }, "source")
    narrow_restored(session, table)
    assert session.commands is not None
    assert [
        (r.reason, r.commands, r.paths) for r in session.commands.deny
    ] == [
        ("no pushing from the vault", ("git push", ), ("/vault/*", )),
        ("no pushing from the vault", ("git push", ), ("/vault/public/*", )),
    ]
    assert _answer(session, "git", "/vault/public/x",
                   words=("push", )) is Outcome.DENY
    assert _answer(session, "git", "/vault/public/x",
                   words=("pull", )) is Outcome.ASK


# A deny the other side's own deeper ask already outranks is not
# restated: that side's answer at the entry was a question, so there is
# no refusal to keep, and restating it would refuse a line neither side
# refuses.
def test_narrow_restored_leaves_a_deny_the_other_side_carved_out_itself():
    session = _ruled(
        {
            "commands": {
                "allow": ["cat", "echo"],
                "deny": [{
                    "reason": "vault is sealed",
                    "commands": {
                        "cat": ["/vault/*"]
                    }
                }],
                "ask": [{
                    "reason": "public needs a nod",
                    "commands": {
                        "cat": ["/vault/public/*"]
                    }
                }],
            }
        }, "target")
    table = _ruled(
        {
            "commands": {
                "allow": ["cat", "echo"],
                "ask": [{
                    "reason": "reports need a nod",
                    "commands": {
                        "cat": ["/vault/public/reports/*"]
                    }
                }],
            }
        }, "source")
    narrow_restored(session, table)
    assert session.commands is not None
    assert [(r.reason, r.paths) for r in session.commands.deny
            ] == [("vault is sealed", ("/vault/*", ))]
    assert _answer(session, "cat", "/vault/public/reports/q") is Outcome.ASK
    assert _answer(session, "cat", "/vault/other") is Outcome.DENY


# Joining a rule set with itself is a no-op, carve-outs included: a
# checkout feeds live tables back through the restore, and a document's
# own deeper ask over its own deny is its answer, not a lifted refusal.
def test_narrow_restored_joins_a_rule_set_with_itself_as_a_no_op():
    doc = {
        "commands": {
            "allow": ["cat", "echo"],
            "deny": [{
                "reason": "vault is sealed",
                "commands": {
                    "cat": ["/vault/*"]
                }
            }],
            "ask": [{
                "reason": "public needs a nod",
                "commands": {
                    "cat": ["/vault/public/*"]
                }
            }],
        }
    }
    session = _ruled(doc, "target")
    before = session.commands
    narrow_restored(session, _ruled(doc, "source"))
    assert session.commands is before
    assert _answer(session, "cat", "/vault/public/x") is Outcome.ASK


# A table whose show list spells one path twice keeps what was in
# force, not what was written last: `shown_mode` takes the weaker of
# two entries at a depth, so matching against the raw list paired the
# session against the wrong spelling and restored an executable
# subtree the source only ever read.
def test_narrow_restored_folds_a_duplicate_table_show_to_its_weakest():
    session = Session(
        session_id="s",
        hidden_paths=HiddenPaths(paths=("/repo", )),
        shown_paths=ShownPaths(
            entries=(ShowEntry(path="/repo/build", mode=MountMode.EXEC), )))
    narrow_restored(
        session,
        _restored(hidden_paths=HiddenPaths(paths=("/repo", )),
                  shown_paths=ShownPaths(entries=(
                      ShowEntry(path="/repo/build", mode=MountMode.READ),
                      ShowEntry(path="/repo/build", mode=MountMode.EXEC),
                  ))))
    assert session.shown_paths == ShownPaths(
        entries=(ShowEntry(path="/repo/build", mode=MountMode.READ), ))


# An anchored pattern is asked the same question as a path, so a
# broader pattern grants a narrower one and the narrower survives as
# the intersection, exactly as two nested exact carve-outs do. Two
# patterns that only overlap have no single entry naming their common
# ground and are both dropped -- the narrowing direction, stated in
# `_grants`.
def test_narrow_restored_keeps_the_narrower_of_two_nested_show_patterns():
    session = Session(
        session_id="s",
        hidden_paths=HiddenPaths(paths=("/vault", )),
        shown_paths=ShownPaths(
            entries=(ShowEntry(path="/vault/a/b/*", mode=None), )))
    narrow_restored(
        session,
        _restored(hidden_paths=HiddenPaths(paths=("/vault", )),
                  shown_paths=ShownPaths(
                      entries=(ShowEntry(path="/vault/a/*", mode=None), ))))
    assert session.shown_paths == ShownPaths(
        entries=(ShowEntry(path="/vault/a/b/*", mode=None), ))
    assert path_visible(session.hidden_paths, session.shown_paths,
                        "/vault/a/b/f.txt")
    assert not path_visible(session.hidden_paths, session.shown_paths,
                            "/vault/a/other.txt")
