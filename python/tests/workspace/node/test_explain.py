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

import asyncio
import dataclasses

import pytest
import pytest_asyncio
from pydantic import BaseModel, ConfigDict

from mirage import Workspace
from mirage.policy import Action, CommandContext, Deny, Policy
from mirage.policy.match import Outcome
from mirage.policy.types import Scope
from mirage.resource.ram import RAMResource
from mirage.runtime.base import Runtime
from mirage.runtime.mixin import LineExecutorMixin
from mirage.runtime.types import RunResult
from mirage.secrets import registry as secrets_registry
from mirage.secrets.registry import register_secrets
from mirage.secrets.types import ResolvedSecret
from mirage.shell.console import JobConsole
from mirage.types import MountMode


class _FakeConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


async def _dead_fetch(config: _FakeConfig, ref: str) -> ResolvedSecret:
    raise RuntimeError("connection refused")


PROFILE = {
    "commands": {
        "allow": [
            "ls", "cat", "git", "rm", "mkdir", "cd", "echo", "sleep", "wait",
            "eval", "command", "xargs", "touch", "printf", "mapfile", "alias",
            "shopt"
        ],
        "deny": [{
            "reason": "production data is protected",
            "commands": {
                "rm": ["/data/prod/*"]
            }
        }],
        "ask": [{
            "reason": "pushes need sign-off",
            "commands": ["git push"]
        }, {
            "reason": "secrets need sign-off",
            "commands": {
                "cat":
                ["/data/secret.txt", "/data/secret file", "/data/secrét"]
            }
        }],
    },
}

# The same world under a rule that speaks on the command name alone, so
# a spelling whose operands only the runtime can read is still asked
# about.
ASK_CAT = {
    "commands": {
        "allow": PROFILE["commands"]["allow"],
        "ask": [{
            "reason": "reads need sign-off",
            "commands": ["cat"]
        }],
    },
}

DENY_CAT = {
    "commands": {
        "allow": PROFILE["commands"]["allow"],
        "deny": [{
            "reason": "reads are refused",
            "commands": ["cat"]
        }],
    },
}


@pytest_asyncio.fixture()
async def ws():
    workspace = Workspace({"/data/": RAMResource()},
                          mode=MountMode.WRITE,
                          profiles={"r": PROFILE})
    await workspace.execute("mkdir -p /data/prod")
    await workspace.fs.write("/data/prod/x.txt", b"x\n")
    await workspace.fs.write("/data/a.txt", b"a\n")
    await workspace.fs.write("/data/secret.txt", b"s\n")
    workspace.create_session("s", profile="r")
    yield workspace
    await workspace.close()


@pytest.mark.asyncio
async def test_explain_answers_each_verb_and_names_the_rule(ws):
    allowed, = await ws.explain("cat /data/a.txt", "s")
    assert allowed.outcome is Outcome.ALLOW
    assert allowed.exit_code == 0
    assert allowed.stderr == ""
    assert allowed.rule is None

    denied, = await ws.explain("rm /data/prod/x.txt", "s")
    assert denied.outcome is Outcome.DENY
    assert denied.rule is not None
    assert denied.reason == "production data is protected"
    assert denied.source == "top"
    assert denied.matched_path == "/data/prod/x.txt"

    asked, = await ws.explain("git push origin main", "s")
    assert asked.outcome is Outcome.ASK
    assert asked.reason == "pushes need sign-off"


@pytest.mark.asyncio
async def test_a_word_the_session_cannot_see_is_deny_at_127(ws):
    # Both refusals the allow list produces are DENY with no rule; the
    # exit code is what separates a head word the session cannot see
    # from a line no allow entry covers.
    missing, = await ws.explain("gerp x", "s")
    assert missing.outcome is Outcome.DENY
    assert missing.rule is None
    assert missing.source == "commands.allow"
    assert missing.exit_code == 127
    assert missing.stderr == "gerp: command not found\n"


@pytest.mark.asyncio
async def test_explain_reads_every_command_of_a_line(ws):
    first, second = await ws.explain("cat /data/a.txt && rm /data/prod/x.txt",
                                     "s")
    assert (first.command, first.outcome) == ("cat", Outcome.ALLOW)
    assert (second.command, second.outcome) == ("rm", Outcome.DENY)


@pytest.mark.asyncio
async def test_explain_says_exactly_what_the_run_would_say(ws):
    for line in ("rm /data/prod/x.txt", "git push origin main", "gerp x"):
        ran = await ws.execute(line, session_id="s")
        said, = await ws.explain(line, "s")
        assert said.exit_code == ran.exit_code
        assert said.stderr == (ran.stderr or b"").decode()


@pytest.mark.asyncio
async def test_explain_spends_nothing(ws):
    # A dry run of an ask must not put the question to anyone, or the
    # host would field requests for lines nobody typed, and must not
    # spend a grant, or explaining a line would use up its answer.
    for _ in range(3):
        await ws.explain("git push origin main", "s")
    assert ws.decisions.pending() == ()
    assert ws.get_session("s").decisions == ()
    await ws.explain("rm /data/prod/x.txt", "s")
    assert sorted(await ws.fs.readdir("/data")) == [
        "/data/a.txt", "/data/prod", "/data/secret.txt"
    ]


@pytest.mark.asyncio
async def test_a_denied_command_stops_the_whole_line(ws):
    # The agent composed the line as one intent, so a rule refusing
    # part of it refuses the intent: judging each command as the
    # dispatcher reached it deleted the first file and refused the
    # second.
    ran = await ws.execute("rm /data/a.txt && rm /data/prod/x.txt",
                           session_id="s")
    assert ran.exit_code == 1
    assert ran.stderr == (
        b"rm: /data/prod/x.txt: production data is protected\n")
    assert "/data/a.txt" in await ws.fs.readdir("/data")


@pytest.mark.asyncio
async def test_a_word_the_session_cannot_see_leaves_the_line_alone(ws):
    # A head word the session cannot see is a routing miss, not a
    # verdict, so it stays bash: the stage fails and the rest of the
    # line does what bash does. A typo must not cost an agent the work
    # the line already did.
    ran = await ws.execute("rm /data/a.txt && gerp x", session_id="s")
    assert ran.exit_code == 127
    assert ran.stderr == b"gerp: command not found\n"
    assert "/data/a.txt" not in await ws.fs.readdir("/data")


@pytest.mark.asyncio
async def test_an_asked_command_holds_the_line_until_it_is_answered(ws):
    line = "rm /data/a.txt && cat /data/secret.txt"
    ran = await ws.execute(line, session_id="s")
    assert ran.exit_code == 126
    assert "/data/a.txt" in await ws.fs.readdir("/data")
    # Exactly one request, from the one pass that judged the line.
    pending, = ws.decisions.pending()
    await ws.decisions.answer(pending.id, Outcome.ALLOW, Scope.ONCE)
    # The whole line replays, which is only sound because none of it
    # ran the first time, and the grant is spent exactly once even
    # though two passes now read it.
    again = await ws.execute(line, session_id="s")
    assert again.exit_code == 0
    assert "/data/a.txt" not in await ws.fs.readdir("/data")
    assert ws.decisions.pending() == ()


@pytest.mark.asyncio
async def test_a_cd_earlier_in_the_line_moves_what_later_rules_read(ws):
    # The line is judged before it runs, so the pass has to walk a
    # literal `cd` itself or a rule about /data/prod would answer about
    # whatever directory the session happened to be in.
    ran = await ws.execute("cd /data/prod && rm x.txt", session_id="s")
    assert ran.exit_code == 1
    assert ran.stderr == b"rm: x.txt: production data is protected\n"


@pytest.mark.asyncio
async def test_explain_reads_a_cd_the_same_way_the_run_does(ws):
    # explain and the pass that decides the line share one walk, so a
    # host asking about a line and the agent typing it cannot be told
    # different things about where the line ends up.
    line = "cd /data/prod && rm x.txt"
    _, removed = await ws.explain(line, "s")
    assert removed.outcome is Outcome.DENY
    ran = await ws.execute(line, session_id="s")
    assert removed.exit_code == ran.exit_code
    assert removed.stderr == (ran.stderr or b"").decode()


@pytest.mark.asyncio
async def test_the_hold_reaches_only_as_far_as_the_text_does(ws):
    # The pass reads the text of a line and the gate reads its values,
    # so a path the runtime computes is invisible here and the hold
    # lapses. The ask still fires, at the gate, once the earlier
    # commands have run. Pinned rather than only documented, because
    # the cost lands on the replay: approving this re-runs a line whose
    # first half is already done.
    ran = await ws.execute("S=/data/secret.txt; rm /data/a.txt && cat $S",
                           session_id="s")
    assert ran.exit_code == 126
    assert "/data/a.txt" not in await ws.fs.readdir("/data")
    assert len(ws.decisions.pending()) == 1


@pytest.mark.asyncio
async def test_a_cd_in_a_subshell_does_not_move_later_commands(ws):
    # bash restores the cwd when the subshell exits, so carrying the cd
    # past it refused a line that was never going to touch /data/prod.
    ran = await ws.execute("(cd /data/prod && ls) && rm x.txt", session_id="s")
    assert ran.exit_code == 1
    assert b"production data is protected" not in (ran.stderr or b"")
    assert "/data/prod/x.txt" in await ws.fs.readdir("/data/prod")


@pytest.mark.asyncio
async def test_a_grant_the_session_holds_shows_the_line_running(ws):
    ran = await ws.execute("git push origin main", session_id="s")
    assert ran.exit_code == 126
    pending, = ws.decisions.pending()
    await ws.decisions.answer(pending.id, Outcome.ALLOW, Scope.SESSION)
    # The document still says ask, because that is what it says; the
    # exit code says 0, because that is what the line would now do.
    asked, = await ws.explain("git push origin main", "s")
    assert asked.outcome is Outcome.ASK
    assert asked.exit_code == 0
    assert asked.stderr == ""


SEALED = {
    "commands": {
        "allow": ["ls", "cat", "rm", "mkdir", "echo"],
        "deny": [{
            "reason": "sealed until review",
            "paths": ["/data/prod/*"],
        }],
    },
}


@pytest_asyncio.fixture()
async def sealed():
    workspace = Workspace({"/data/": RAMResource()},
                          mode=MountMode.WRITE,
                          profiles={"r": SEALED})
    await workspace.execute("mkdir -p /data/prod")
    await workspace.fs.write("/data/prod/x.txt", b"x\n")
    await workspace.fs.write("/data/a.txt", b"a\n")
    workspace.create_session("s", profile="r")
    yield workspace
    await workspace.close()


@pytest.mark.asyncio
async def test_explain_reads_the_statements_redirect_target(sealed):
    # The shell opens a redirect on its own fd, outside the window the
    # command's own gate covers, so admission reads the target as a word
    # of the command. The dry run has to read it the same way or it
    # answers ALLOW for a line the run refuses.
    said, = await sealed.explain("echo x > /data/prod/x.txt", "s")
    assert said.outcome is Outcome.DENY
    assert said.reason == "sealed until review"


@pytest.mark.asyncio
async def test_a_rule_on_a_redirect_target_holds_the_whole_line(sealed):
    ran = await sealed.execute("rm /data/a.txt && echo x > /data/prod/x.txt",
                               session_id="s")
    assert ran.exit_code != 0
    assert b"sealed until review" in (ran.stderr or b"")
    assert "/data/a.txt" in await sealed.fs.readdir("/data")


class _NoCat(Policy):

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        """Refuse cat, the way a deployment's own policy would.

        Args:
            ctx (CommandContext): the classified command.
        """
        return Deny(
            "cat is refused by policy") if ctx.command == "cat" else None


@pytest_asyncio.fixture()
async def coded():
    workspace = Workspace({"/data/": RAMResource()},
                          mode=MountMode.WRITE,
                          policies=[_NoCat()])
    await workspace.fs.write("/data/a.txt", b"a\n")
    await workspace.fs.write("/data/b.txt", b"b\n")
    yield workspace
    await workspace.close()


@pytest.mark.asyncio
async def test_a_coded_policy_holds_the_line_without_a_document(coded):
    # A session with no permissions document still runs under whatever
    # policies the deployment registered, and one is always registered
    # (MountRootPolicy). Returning early on `commands is None` held the
    # line for a document and left a policy with the half-line behavior
    # the pass exists to remove.
    ran = await coded.execute("rm /data/a.txt && cat /data/b.txt")
    assert ran.exit_code != 0
    assert ran.stderr == b"cat: Permission denied\n"
    assert ran.refusal is not None
    assert ran.refusal.reason == "cat is refused by policy"
    assert "/data/a.txt" in await coded.fs.readdir("/data")


def _answering(asked: list[str], outcome: Outcome, scope: Scope = Scope.ONCE):
    """A host answering every question the same way, counting what it
    was asked.

    Args:
        asked (list[str]): where each question's id is appended.
        outcome (Outcome): the answer given.
        scope (Scope): how far it reaches.
    """

    async def host(record):
        asked.append(record.id)
        return dataclasses.replace(record, outcome=outcome, scope=scope)

    return host


async def _inline_workspace(on_ask, profile=PROFILE) -> Workspace:
    """The same world as the ``ws`` fixture, with a host that answers an
    ask inline.

    Args:
        on_ask (AskHandler): the host.
        profile (dict): the document session ``s`` runs under.
    """
    workspace = Workspace({"/data/": RAMResource()},
                          mode=MountMode.WRITE,
                          profiles={"r": profile},
                          on_ask=on_ask)
    await workspace.execute("mkdir -p /data/prod")
    await workspace.fs.write("/data/prod/x.txt", b"x\n")
    await workspace.fs.write("/data/a.txt", b"a\n")
    await workspace.fs.write("/data/secret.txt", b"s\n")
    workspace.create_session("s", profile="r")
    return workspace


@pytest_asyncio.fixture()
async def inline():
    workspace = await _inline_workspace(_answering([], Outcome.ALLOW))
    yield workspace
    await workspace.close()


@pytest.mark.asyncio
async def test_an_answered_ask_does_not_end_the_scan(inline):
    # The host answers the cat inline, so admit admits it. The rest of
    # the line has not been judged yet: reading that admission as "the
    # line is fine" let the later deny run behind an approval, which is
    # the half-line behavior in its worst form, since the agent was
    # told yes.
    ran = await inline.execute("cat /data/secret.txt && rm /data/prod/x.txt",
                               session_id="s")
    assert ran.exit_code != 0
    assert b"production data is protected" in (ran.stderr or b"")
    assert b"s\n" not in (ran.stdout or b"")
    assert "/data/prod/x.txt" in await inline.fs.readdir("/data/prod")


@pytest.mark.asyncio
async def test_a_compound_line_answered_inline_asks_once_per_run():
    # Two passes read this line: the one that judges every command
    # before any runs, and the per-command gate, which runs it. The host
    # answers the cat in the first, and that one nod has to carry the
    # line through the gate, or the human is asked twice for one run. It
    # carries no further: the next identical line is a new question.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        line = "rm /data/a.txt && cat /data/secret.txt"
        ran = await ws.execute(line, session_id="s")
        assert ran.exit_code == 0
        assert ran.stdout == b"s\n"
        assert len(asked) == 1
        await ws.fs.write("/data/a.txt", b"a\n")
        again = await ws.execute(line, session_id="s")
        assert again.exit_code == 0
        assert len(asked) == 2
        # Both grants were spent by the lines they were given for.
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_refused_compound_line_is_refused_again_without_asking():
    # The human who said no is not asked about the agent's immediate
    # retry: the refusal stands to refuse it from the record, is spent
    # by it, and the run after that is an open question again. The same
    # rule the per-command gate keeps for a one-command line.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.DENY))
    try:
        line = "rm /data/a.txt && cat /data/secret.txt"
        for expected in (1, 1, 2):
            ran = await ws.execute(line, session_id="s")
            assert ran.exit_code == 126
            assert len(asked) == expected
        assert "/data/a.txt" in await ws.fs.readdir("/data")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_grant_handed_to_a_refused_line_does_not_outlive_it():
    # The host allows the cat inline and the pass hands that grant to
    # the gate, which never runs: the rm behind it is refused first.
    # Left standing, the grant would pass the next cat of the secret on
    # a nod given to a line that never ran, so the refusal spends it
    # and the next cat is a question again.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.execute("cat /data/secret.txt && rm /data/prod/x.txt",
                               session_id="s")
        assert ran.exit_code != 0
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
        again = await ws.execute("cat /data/secret.txt", session_id="s")
        assert again.exit_code == 0
        assert again.stdout == b"s\n"
        assert len(asked) == 2
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_grant_the_run_never_reaches_does_not_outlive_the_line():
    # The host allows the cat inline and the line runs, but the failed
    # cat before it short-circuits the && and the gate that would have
    # spent the grant never runs. The line is over all the same, so the
    # grant is swept with it and the next cat is a question again.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.execute("cat /data/missing && cat /data/secret.txt",
                               session_id="s")
        assert ran.exit_code == 1
        assert ran.stdout == b""
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
        again = await ws.execute("cat /data/secret.txt", session_id="s")
        assert again.exit_code == 0
        assert again.stdout == b"s\n"
        assert len(asked) == 2
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_grant_does_not_outlive_a_line_that_fails_before_it_runs(
        monkeypatch):
    # The host allows the cat inline, and then the secret the echo reads
    # cannot be fetched, so the line fails between the preflight and the
    # run: no gate runs at all. The sweep covers that stretch too, or
    # the next cat would run on a nod given to a line that never did.
    monkeypatch.setattr(secrets_registry, "_CUSTOM", {})
    register_secrets("fake", _FakeConfig, _dead_fetch)
    asked: list[str] = []
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   profiles={"r": PROFILE},
                   env={"TOKEN": {
                       "from": "fake",
                       "ref": "r"
                   }},
                   on_ask=_answering(asked, Outcome.ALLOW))
    try:
        await ws.fs.write("/data/secret.txt", b"s\n")
        ws.create_session("s", profile="r")
        ran = await ws.execute("cat /data/secret.txt && echo $TOKEN",
                               session_id="s")
        assert ran.exit_code == 1
        assert ran.stderr == b"TOKEN: cannot fetch from fake\n"
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
        again = await ws.execute("cat /data/secret.txt", session_id="s")
        assert again.exit_code == 0
        assert again.stdout == b"s\n"
        assert len(asked) == 2
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("line", [
    "sleep 0.2 && cat /data/secret.txt &",
    "eval 'sleep 0.2 && cat /data/secret.txt &'",
    "eval \"eval 'sleep 0.2 && cat /data/secret.txt &'\"",
])
async def test_a_grant_stays_with_a_background_job_until_it_ends(line):
    # The line returns as soon as the job is launched, long before the
    # job's cat reaches its gate. The grant the host gave the line is
    # the job's to spend, so the line's end leaves it standing and the
    # job's end sweeps it; revoked with the line, the cat would have
    # asked again from inside the job.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.execute(line, session_id="s")
        assert ran.exit_code == 0
        assert len(asked) == 1
        assert len(ws.decisions.list("s")) == 1
        waited = await ws.execute("wait", session_id="s")
        assert waited.exit_code == 0
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_out_of_band_grant_stays_with_a_nested_background_job(ws):
    line = "eval 'sleep 0.2 && cat /data/secret.txt > /data/read.txt &'"
    first = await ws.execute(line, session_id="s")
    assert first.refusal is not None and first.refusal.kind == "pending"
    await ws.decisions.answer(first.refusal.ask_id, Outcome.ALLOW)
    ran = await ws.execute(line, session_id="s")
    assert ran.exit_code == 0
    assert len(ws.decisions.list("s")) == 1
    elsewhere, = await ws.explain("cat /data/secret.txt", "s")
    assert elsewhere.outcome is Outcome.ASK
    waited = await ws.execute("wait", session_id="s")
    assert waited.exit_code == 0
    assert await ws.fs.read("/data/read.txt") == b"s\n"
    assert ws.decisions.list("s") == ()


@pytest.mark.asyncio
async def test_a_command_spelled_twice_on_a_line_needs_two_answers(ws):
    # One out-of-band answer covers one spelling. Read for both, the
    # first cat would run and spend it before the second was found
    # wanting, which is the half-line the hold exists to prevent: the
    # retry is held whole until the second spelling has its own answer.
    line = "cat /data/secret.txt && cat /data/secret.txt"
    first = await ws.execute(line, session_id="s")
    assert first.exit_code == 126
    assert first.refusal is not None and first.refusal.kind == "pending"
    await ws.decisions.answer(first.refusal.ask_id, Outcome.ALLOW)
    second = await ws.execute(line, session_id="s")
    assert second.exit_code == 126
    assert second.stdout == b""
    assert second.refusal is not None and second.refusal.kind == "pending"
    assert len(ws.decisions.list("s")) == 2
    await ws.decisions.answer(second.refusal.ask_id, Outcome.ALLOW)
    ran = await ws.execute(line, session_id="s")
    assert ran.exit_code == 0
    assert ran.stdout == b"s\ns\n"
    assert ws.decisions.list("s") == ()


@pytest.mark.asyncio
async def test_two_lines_judged_at_once_cannot_both_run_on_one_nod(ws):
    # One out-of-band answer, two identical compound lines executed
    # concurrently on the session. The line whose pass claims the grant
    # first runs; the other must be held whole, not run its ls and then
    # find the grant gone at its cat.
    line = "ls /data && cat /data/secret.txt"
    first = await ws.execute(line, session_id="s")
    assert first.refusal is not None and first.refusal.kind == "pending"
    await ws.decisions.answer(first.refusal.ask_id, Outcome.ALLOW)
    ran, held = sorted(await asyncio.gather(ws.execute(line, session_id="s"),
                                            ws.execute(line, session_id="s")),
                       key=lambda r: r.exit_code)
    assert ran.exit_code == 0
    assert ran.stdout == b"a.txt\nprod\nsecret.txt\ns\n"
    assert held.exit_code == 126
    assert held.stdout == b""
    assert held.refusal is not None and held.refusal.kind == "pending"


@pytest.mark.asyncio
async def test_a_grant_given_before_a_refused_line_does_not_outlive_it(ws):
    # The cat was answered out of band while the line waited; its retry
    # is then refused by the rm. That grant was given to this line as
    # surely as an inline one, so the refusal spends it too, and the
    # next cat is a question again rather than a run on a nod given to
    # a line that never ran.
    line = "cat /data/secret.txt && rm /data/prod/x.txt"
    first = await ws.execute(line, session_id="s")
    assert first.exit_code == 126
    assert first.refusal is not None and first.refusal.kind == "pending"
    await ws.decisions.answer(first.refusal.ask_id, Outcome.ALLOW)
    retry = await ws.execute(line, session_id="s")
    assert retry.exit_code != 0
    assert b"production data is protected" in (retry.stderr or b"")
    assert ws.decisions.list("s") == ()
    again = await ws.execute("cat /data/secret.txt", session_id="s")
    assert again.exit_code == 126
    assert again.refusal is not None and again.refusal.kind == "pending"


@pytest.mark.asyncio
async def test_a_cd_in_a_subshell_moves_the_commands_inside_it(ws):
    # The sibling test pins that the cd does not escape the subshell.
    # This one pins the other half: inside it, the cd still applies, so
    # the rule about /data/prod reads x.txt as the file it is. Reading a
    # subshell as "no cd applies" judged the command at the session cwd.
    ran = await ws.execute("(cd /data/prod && rm x.txt)", session_id="s")
    assert ran.exit_code == 1
    assert ran.stderr == b"rm: x.txt: production data is protected\n"
    assert "/data/prod/x.txt" in await ws.fs.readdir("/data/prod")


@pytest.mark.asyncio
async def test_a_one_command_line_is_refused_inside_the_shell(ws):
    # Nothing runs before a single command, so there is no hold to buy
    # and the per-command gate answers instead. That is the more
    # faithful answer, not just the cheaper one: the gate refuses from
    # inside the shell, so `2>&1` still moves the message, where this
    # pass answers above the redirect layer and would leave it on
    # stderr.
    ran = await ws.execute("rm /data/prod/x.txt 2>&1", session_id="s")
    assert ran.exit_code == 1
    assert ran.stdout == (
        b"rm: /data/prod/x.txt: production data is protected\n")
    assert ran.stderr in (b"", None)


@pytest.mark.asyncio
async def test_a_grant_claimed_for_a_nested_line_is_the_inner_gates():
    # The pass reads into a substitution, so the cat inside $( ) is
    # judged and its grant claimed before the line runs. The inner line
    # re-enters the executor as a line of its own; with a hand-off
    # unlinked to the outer one, its gate read that claim as another
    # line's reservation and asked the human a second time for one run.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.execute("echo $(cat /data/secret.txt) && ls /data",
                               session_id="s")
        assert ran.exit_code == 0
        assert ran.stdout.startswith(b"s\n")
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_nested_line_runs_on_the_answer_its_outer_line_was_given(ws):
    # Out of band: the question is the outer pass's, and the answer has
    # to reach the gate inside the substitution on the retry.
    line = "echo $(cat /data/secret.txt) && ls /data"
    first = await ws.execute(line, session_id="s")
    assert first.exit_code == 126
    assert first.refusal is not None and first.refusal.kind == "pending"
    await ws.decisions.answer(first.refusal.ask_id, Outcome.ALLOW)
    ran = await ws.execute(line, session_id="s")
    assert ran.exit_code == 0
    assert ran.stdout.startswith(b"s\n")
    assert ws.decisions.list("s") == ()


@pytest.mark.asyncio
async def test_a_nested_line_spelled_twice_costs_two_nods_and_no_more():
    # The outer pass reads the line eval runs and claims one grant per
    # spelling. The inner line's own pass then finds both standing for
    # its two occurrences rather than asking for either again, and its
    # gates spend them.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.execute(
            "eval 'cat /data/secret.txt && cat /data/secret.txt' && ls /data",
            session_id="s")
        assert ran.exit_code == 0
        assert ran.stdout.startswith(b"s\ns\n")
        assert len(asked) == 2
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


class _LineBox(Runtime, LineExecutorMixin):
    name = "sandbox"
    captures = ("*", )

    def __init__(self) -> None:
        self.lines: list[str] = []

    async def run_line(self, line: str, stdin: bytes | None,
                       env: dict[str, str], cwd: str) -> RunResult:
        self.lines.append(line)
        return RunResult(stdout=b"box:" + line.encode(),
                         stderr=None,
                         exit_code=0)


@pytest.mark.asyncio
async def test_a_whole_line_keeps_its_first_answer_while_its_second_waits():
    # A runtime that takes the line whole has no per-command gate, so
    # its admission pass is the only reader. Spending there, the cat's
    # answer was gone by the time the push's question came back, and
    # every retry asked for the cat again; the answers could never
    # accumulate to a line that runs.
    box = _LineBox()
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.EXEC,
                   profiles={"r": PROFILE},
                   runtimes=[box, "vfs"])
    try:
        await ws.fs.write("/data/secret.txt", b"s\n")
        ws.create_session("s", profile="r")
        line = "cat /data/secret.txt && git push origin main"
        first = await ws.execute(line, session_id="s")
        assert first.exit_code == 126
        assert first.refusal is not None and first.refusal.kind == "pending"
        await ws.decisions.answer(first.refusal.ask_id, Outcome.ALLOW)
        second = await ws.execute(line, session_id="s")
        assert second.exit_code == 126
        assert second.refusal is not None and second.refusal.kind == "pending"
        assert len(ws.decisions.list("s")) == 2
        assert box.lines == []
        await ws.decisions.answer(second.refusal.ask_id, Outcome.ALLOW)
        ran = await ws.execute(line, session_id="s")
        assert ran.exit_code == 0
        assert box.lines == [line]
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


def _no_console(job_id: int) -> JobConsole:
    raise RuntimeError("no console")


@pytest.mark.asyncio
async def test_a_job_that_cannot_be_submitted_hands_its_borrow_back():
    # The job borrows the line's hand-off before it is submitted, and
    # its runner hands it back. A submission that fails starts no
    # runner, so the borrow has to be handed back at the failure, or
    # the hand-off stays a holder short of release for good and its
    # grant is neither spent nor on offer to any later line.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ws.job_table._console_factory = _no_console
        ran = await ws.execute("cat /data/secret.txt & ls /data",
                               session_id="s")
        assert ran.exit_code != 0
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
        ws.job_table._console_factory = None
        again = await ws.execute("cat /data/secret.txt", session_id="s")
        assert again.exit_code == 0
        assert again.stdout == b"s\n"
        assert len(asked) == 2
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_word_that_expands_to_a_judged_command_does_not_run_on_its_nod(
        ws):
    # The pass reads the literal cat and claims the answer for it; the
    # first cat's operand expands at run time into the same command.
    # Read by spelling, that gate found the literal's grant and read the
    # secret before its own question was ever put, and the literal then
    # asked again. Bound to its occurrence, the grant is the literal's
    # alone: the expanded command asks, its question holds the line,
    # and the retry runs both on their own answers.
    line = "F=/data/secret.txt; cat $F && cat /data/secret.txt"
    first = await ws.execute(line, session_id="s")
    assert first.exit_code == 126
    assert first.refusal is not None and first.refusal.kind == "pending"
    await ws.decisions.answer(first.refusal.ask_id, Outcome.ALLOW)
    second = await ws.execute(line, session_id="s")
    assert second.exit_code == 126
    assert second.stdout == b""
    assert second.refusal is not None and second.refusal.kind == "pending"
    assert len(ws.decisions.list("s")) == 2
    await ws.decisions.answer(second.refusal.ask_id, Outcome.ALLOW)
    ran = await ws.execute(line, session_id="s")
    assert ran.exit_code == 0
    assert ran.stdout == b"s\ns\n"
    assert ws.decisions.list("s") == ()


@pytest.mark.asyncio
async def test_one_body_under_two_words_is_two_occurrences():
    # The same substitution twice on a line is two questions, and each
    # nested line spends its own: the second body cannot be answered by
    # the first body's nod, nor ask a third time.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.execute(
            "echo $(cat /data/secret.txt) $(cat /data/secret.txt) && ls /data",
            session_id="s")
        assert ran.exit_code == 0
        assert ran.stdout.startswith(b"s s\n")
        assert len(asked) == 2
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_words_handed_on_by_command_are_one_question():
    # command re-runs its operands as one line, joined with shlex so an
    # operand holding a space survives the re-parse. The pass has to
    # read the words the same way, or the occurrence it claims the
    # answer for is not the one the nested gate computes, and the cat
    # asks a second time after the echo has already run.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        await ws.fs.write("/data/secret file", b"s\n")
        ran = await ws.execute("echo x && command cat '/data/secret file'",
                               session_id="s")
        assert ran.exit_code == 0
        assert ran.stdout == b"x\ns\n"
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_held_line_keeps_its_jobs_grant_reserved(ws):
    # The job is launched on the grant the pass claimed for its cat,
    # and the foreground cat expands into a question that holds the
    # line. A hold that let go of the job's grant with the line's left
    # it standing for anyone while the job slept, so a line judged then
    # ran on it and the job asked again. The grant is the job's own:
    # the other line asks, and the job runs on its nod.
    line = "F=/data/secret.txt; sleep 0.5 && cat /data/secret.txt & cat $F"
    first = await ws.execute(line, session_id="s")
    assert first.refusal is not None and first.refusal.kind == "pending"
    await ws.decisions.answer(first.refusal.ask_id, Outcome.ALLOW)
    held = await ws.execute(line, session_id="s")
    assert held.exit_code == 126
    assert held.refusal is not None and held.refusal.kind == "pending"
    other = await ws.execute("cat /data/secret.txt", session_id="s")
    assert other.exit_code == 126
    assert other.refusal is not None and other.refusal.kind == "pending"
    waited = await ws.execute("wait", session_id="s")
    assert waited.exit_code == 0
    assert len(ws.decisions.pending("s")) == len(ws.decisions.list("s"))


@pytest.mark.asyncio
async def test_touching_backtick_pairs_hold_the_line_as_the_lines_they_run(ws):
    # tree-sitter lexes the two pairs as one node whose subtree is one
    # merged command that never runs. Judged on that spelling, the pass
    # saw no readable cat and nothing held the line: the echo ran, and
    # only then did the cat's gate, running its own pair as a line, ask.
    # Read as the lines the evaluator runs, the pass asks first and
    # holds the whole line.
    line = "echo x && echo `cat /data/secret.txt` `echo ok`"
    first = await ws.execute(line, session_id="s")
    assert first.exit_code == 126
    assert first.stdout == b""
    assert first.refusal is not None and first.refusal.kind == "pending"
    await ws.decisions.answer(first.refusal.ask_id, Outcome.ALLOW)
    ran = await ws.execute(line, session_id="s")
    assert ran.exit_code == 0
    assert ran.stdout == b"x\ns ok\n"
    assert ws.decisions.list("s") == ()


@pytest.mark.asyncio
async def test_two_backtick_pairs_of_one_node_are_two_occurrences():
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.execute(
            "echo `cat /data/secret.txt` `cat /data/secret.txt`",
            session_id="s")
        assert ran.exit_code == 0
        assert ran.stdout == b"s s\n"
        assert len(asked) == 2
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_operand_holding_a_multibyte_character_is_one_question():
    # The nested gate places the cat by the parser's byte offsets, and
    # the occurrence the pass claimed for it ended in code points, one
    # short per multibyte character: the grant was hidden from the gate
    # and the cat asked a second time after the echo had already run.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        await ws.fs.write("/data/secrét", b"s\n")
        ran = await ws.execute("echo x && command cat /data/secrét",
                               session_id="s")
        assert ran.exit_code == 0
        assert ran.stdout == b"x\ns\n"
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_pair_after_a_multibyte_character_runs_on_its_own_nod():
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.execute("echo `echo é` `cat /data/secret.txt`",
                               session_id="s")
        assert ran.exit_code == 0
        assert ran.stdout == "é s\n".encode()
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("line", [
    "for i in 1 2; do touch /data/mark.txt; cat /data/secret.txt; done",
    "for i in 1 2; do cat /data/secret.txt; done",
])
async def test_a_loop_runs_every_visit_of_a_command_on_one_nod(line):
    # The loop body is one place on the line, visited twice. The grant
    # for the cat is bound to that place until the line ends, whether
    # the pass claimed it or the first gate to reach it did (the pass
    # leaves a one-command body to the gate), so the second iteration
    # runs on it instead of asking again after the touch ran once more.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.execute(line, session_id="s")
        assert ran.exit_code == 0
        assert ran.stdout == b"s\ns\n"
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_held_loop_replays_on_the_one_answer_it_was_given(ws):
    line = "for i in 1 2; do touch /data/mark.txt; cat /data/secret.txt; done"
    first = await ws.execute(line, session_id="s")
    assert first.exit_code == 126
    assert "/data/mark.txt" not in await ws.fs.readdir("/data")
    pending, = ws.decisions.pending()
    await ws.decisions.answer(pending.id, Outcome.ALLOW)
    again = await ws.execute(line, session_id="s")
    assert again.exit_code == 0
    assert again.stdout == b"s\ns\n"
    assert ws.decisions.list("s") == ()


@pytest.mark.asyncio
@pytest.mark.parametrize("line", [
    "touch /data/mark.txt && echo /data/secret.txt | xargs cat",
    "F=/data/secret.txt; touch /data/mark.txt; cat $F",
])
async def test_a_spelling_the_runtime_completes_is_asked_about_at_the_gate(
        line):
    # The pass reads `xargs cat` as a bare cat and `cat $F` as the word
    # typed, and the gate reads neither: xargs appends its items and $F
    # expands. A question asked here about either spelling would be
    # answered for words that never run, and the gate would ask again
    # about the words that do, so the pass leaves the question to the
    # gate and the human is asked once, about the real operand. The
    # touch has run by then; the hold does not reach a spelling the
    # runtime completes.
    seen: list[tuple[str, ...]] = []

    async def host(record):
        seen.append((record.command, *record.argv))
        return dataclasses.replace(record,
                                   outcome=Outcome.ALLOW,
                                   scope=Scope.ONCE)

    ws = await _inline_workspace(host, ASK_CAT)
    try:
        ran = await ws.execute(line, session_id="s")
        assert ran.exit_code == 0
        assert ran.stdout == b"s\n"
        assert seen == [("cat", "/data/secret.txt")]
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("line", [
    "touch /data/mark.txt && echo /data/secret.txt | xargs cat",
    "F=/data/secret.txt; touch /data/mark.txt; cat $F",
])
async def test_a_deny_on_a_spelling_the_runtime_completes_holds_the_line(line):
    # A deny speaks on the command name alone, which the pass can read
    # whatever the runtime appends, so it still refuses the whole line
    # before the touch runs.
    ws = await _inline_workspace(_answering([], Outcome.ALLOW), DENY_CAT)
    try:
        ran = await ws.execute(line, session_id="s")
        assert ran.exit_code == 126
        assert ran.stderr == b"cat: Permission denied\n"
        assert "/data/mark.txt" not in await ws.fs.readdir("/data")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_every_batch_xargs_hands_on_runs_on_one_nod():
    # Each batch xargs hands on is a nested line of its own, evaluated
    # from the one xargs node, so every batch's cat stands at the same
    # place. What the first batch's gate claims is handed to the outer
    # line when the batch ends, and the second batch runs on it.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.execute(
            "printf '/data/secret.txt /data/secret.txt' | xargs -n1 cat",
            session_id="s")
        assert ran.exit_code == 0
        assert ran.stdout == b"s\ns\n"
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_held_xargs_line_replays_every_batch_on_one_answer(ws):
    line = "printf '/data/secret.txt /data/secret.txt' | xargs -n1 cat"
    first = await ws.execute(line, session_id="s")
    assert first.refusal is not None and first.refusal.kind == "pending"
    pending, = ws.decisions.pending()
    await ws.decisions.answer(pending.id, Outcome.ALLOW)
    again = await ws.execute(line, session_id="s")
    assert again.exit_code == 0
    assert again.stdout == b"s\ns\n"
    assert ws.decisions.list("s") == ()


@pytest.mark.asyncio
async def test_every_job_a_loop_launches_runs_on_one_nod():
    # The loop body launches a job from one place twice (through eval,
    # whose line is a program: a `&` written directly in a loop body
    # still runs in the foreground). Each job takes a copy of the grant
    # claimed for that place, the line's end leaves the grant standing
    # while a job holds it, and the last job's end spends it.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.execute(
            "for i in 1 2; do eval 'sleep 0.2 && "
            "cat /data/secret.txt >> /data/read.txt &'; done",
            session_id="s")
        assert ran.exit_code == 0
        assert len(asked) == 1
        assert len(ws.decisions.list("s")) == 1
        waited = await ws.execute("wait", session_id="s")
        assert waited.exit_code == 0
        assert await ws.fs.read("/data/read.txt") == b"s\ns\n"
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("line", [
    "sleep 0.2 && eval 'cat /data/secret.txt' &",
    "sleep 0.2 && echo $(cat /data/secret.txt) &",
])
async def test_a_line_a_job_evaluates_late_stands_under_the_job(line):
    # The job outlives the line, and only then hands a line on (eval) or
    # expands one ($( )). That line stands under the job's hand-off,
    # which holds the grant the pass claimed for its cat, so the gate
    # runs on it and asks nothing more, and the job's end spends it.
    # Under the finished line's hand-off instead, the gate could not see
    # the job's grant and asked again, and what it then claimed went
    # back to a hand-off nothing revokes, standing for good.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.execute(line, session_id="s")
        assert ran.exit_code == 0
        assert len(asked) == 1
        waited = await ws.execute("wait", session_id="s")
        assert waited.exit_code == 0
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_what_a_jobs_late_gate_claims_is_the_jobs_to_spend():
    # xargs completes cat's words at run time, so the pass leaves the
    # question to the gate, which asks from inside the job after the
    # line has returned. The answer is claimed for the batch's line and
    # handed up to the job's hand-off, whose end spends it; parked on
    # the finished line's, it would stand unspent for good.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.execute(
            "sleep 0.2 && echo /data/secret.txt | xargs cat &", session_id="s")
        assert ran.exit_code == 0
        assert asked == []
        waited = await ws.execute("wait", session_id="s")
        assert waited.exit_code == 0
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


async def _aliased(asked: list[str]) -> Workspace:
    """The inline world with ``c`` an alias for the guarded read and
    ``d`` an alias for ``c``, defined on a line of their own so the
    lines after it expand them.

    Args:
        asked (list[str]): where each question's id is appended.
    """
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    defined = await ws.execute(
        "shopt -s expand_aliases; alias c='cat /data/secret.txt' d=c",
        session_id="s")
    assert defined.exit_code == 0
    return ws


@pytest.mark.asyncio
@pytest.mark.parametrize("line", ["c && c", "c; c", "eval 'c && c'", "d && d"])
async def test_each_invocation_of_an_alias_is_a_place_of_its_own(line):
    # An invocation reads its rewritten line as a line of its own under
    # the word that named it, so two invocations on one line are two
    # places and two questions, as the spelled-out `cat ... && cat ...`
    # is, through an alias of an alias as well. Run on the line's own
    # hand-off instead, both reads stood at the same offsets of the
    # same text, and the second ran on the first's nod.
    asked: list[str] = []
    ws = await _aliased(asked)
    try:
        ran = await ws.execute(line, session_id="s")
        assert ran.exit_code == 0
        assert ran.stdout == b"s\ns\n"
        assert len(asked) == 2
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_one_alias_invocation_reached_twice_runs_on_one_nod():
    # A loop body visits one invocation twice: the same word at the same
    # place reads the same line, so the second visit runs on what the
    # first claimed and handed back to the line, and the line's end
    # spends it.
    asked: list[str] = []
    ws = await _aliased(asked)
    try:
        ran = await ws.execute("for i in 1 2; do c; done", session_id="s")
        assert ran.exit_code == 0
        assert ran.stdout == b"s\ns\n"
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_alias_a_job_runs_late_hands_its_claim_to_the_job():
    # The job expands the alias after the line has returned, so the
    # rewritten line stands under the job's hand-off, not the finished
    # line's: what its gate claims is handed to the job, and the job's
    # end spends it rather than leaving it standing for good.
    asked: list[str] = []
    ws = await _aliased(asked)
    try:
        ran = await ws.execute("sleep 0.2 && c &", session_id="s")
        assert ran.exit_code == 0
        waited = await ws.execute("wait", session_id="s")
        assert waited.exit_code == 0
        assert waited.stdout == b"s\n"
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_mapfile_callback_is_asked_about_at_the_gate():
    # mapfile runs its callback with the index and the record after it,
    # so the callback as typed is a spelling the runtime completes, like
    # the words xargs hands on: the pass leaves its question to the
    # gate, which asks once about the words that run.
    seen: list[tuple[str, ...]] = []

    async def host(record):
        seen.append((record.command, *record.argv))
        return dataclasses.replace(record,
                                   outcome=Outcome.ALLOW,
                                   scope=Scope.ONCE)

    ws = await _inline_workspace(host, ASK_CAT)
    try:
        await ws.execute(
            "touch /data/mark.txt && "
            "printf 'x\\n' | mapfile -t -c 1 -C 'cat /data/secret.txt'",
            session_id="s")
        assert seen == [("cat", "/data/secret.txt", "0", "x")]
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()
