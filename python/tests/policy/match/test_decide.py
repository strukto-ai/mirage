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

from mirage.policy.constants import ASK_SECOND, DENY_FIRST
from mirage.policy.match.decide import decide, outranks, source_of
from mirage.policy.types import (AdmissionRules, CommandContext, CommandRule,
                                 Outcome, Ruling)
from mirage.types import PathSpec


class _Registry:

    def is_mount_root(self, path: str) -> bool:
        return False


def _path(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual.rsplit("/", 1)[0] or "/",
                    vfs_path=virtual,
                    resolved=True,
                    raw_path=virtual)


def _ctx(command: str, *paths: str, cwd: str = "/") -> CommandContext:
    specs = tuple(_path(p) for p in paths)
    return CommandContext(command=command,
                          paths=specs,
                          operands=specs,
                          argv=paths,
                          cwd=cwd,
                          registry=_Registry(),
                          tokens=(command, *paths))


def test_silence_and_the_allow_list_answer_before_any_rule():
    assert decide(_ctx("ls"), None) == Ruling(Outcome.ALLOW)
    assert decide(_ctx("ls"), AdmissionRules()) == Ruling(Outcome.ALLOW)
    listed = AdmissionRules(allow=("cat", ))
    assert decide(_ctx("cat", "/x"), listed).outcome is Outcome.ALLOW
    refused = decide(_ctx("rm", "/x"), listed)
    # The allow list refuses as DENY like any rule; the empty ``rule``
    # is the only thing separating it from one, and is what leaves the
    # refusal with no operator reason to print.
    assert refused.outcome is Outcome.DENY
    assert refused.rule is None
    assert refused.source == "commands.allow"


def test_the_deeper_entry_wins_and_deny_breaks_a_tie():
    broad = CommandRule(reason="broad", commands=("cat", ), paths=("/a/*", ))
    deep = CommandRule(reason="deep", commands=("cat", ), paths=("/a/b/c/*", ))
    rules = AdmissionRules(ask=(deep, ), deny=(broad, ))
    assert decide(_ctx("cat", "/a/b/c/x"), rules).rule is deep
    assert decide(_ctx("cat", "/a/other"), rules).rule is broad
    tied = CommandRule(reason="tied", commands=("cat", ), paths=("/a/*", ))
    both = AdmissionRules(ask=(tied, ), deny=(broad, ))
    assert decide(_ctx("cat", "/a/x"), both).rule is broad


def test_one_operands_ask_never_answers_for_another_operands_deny():
    # The whole reason a line is judged subject by subject: reading one
    # best match for the line let the destination's deeper ask carry the
    # source out of a deny written for it.
    deny = CommandRule(reason="protected",
                       commands=("cp", ),
                       paths=("/protected/*", ))
    ask = CommandRule(reason="review nod",
                      commands=("cp", ),
                      paths=("/review/deep/*", ))
    rules = AdmissionRules(ask=(ask, ), deny=(deny, ))
    decision = decide(_ctx("cp", "/protected/secret", "/review/deep/out"),
                      rules)
    assert decision.outcome is Outcome.DENY
    assert decision.rule is deny
    assert decision.matched_path == "/protected/secret"
    # Each operand on its own still reads as it always did.
    assert decide(_ctx("cp", "/protected/secret", "/elsewhere/out"),
                  rules).rule is deny
    assert decide(_ctx("cp", "/review/deep/x", "/elsewhere/out"),
                  rules).rule is ask


def test_a_carve_out_still_reopens_the_operand_it_was_written_for():
    # The per-subject law must not undo the deeper-wins law: one operand
    # covered by both rules is still the deeper one's.
    deny = CommandRule(reason="sealed", commands=("cat", ), paths=("/a/*", ))
    ask = CommandRule(reason="nod", commands=("cat", ), paths=("/a/open/*", ))
    rules = AdmissionRules(ask=(ask, ), deny=(deny, ))
    assert decide(_ctx("cat", "/a/open/x"), rules).rule is ask
    # A second operand the carve-out says nothing about brings the deny
    # back, because the line has to survive every path it names.
    assert decide(_ctx("cat", "/a/open/x", "/a/sealed"), rules).rule is deny


def test_a_pathless_rule_reaches_every_subject_at_depth_zero():
    # It is off the path axis, so an entry naming a place outranks it,
    # but it still speaks about an operand no entry covers.
    pathless = CommandRule(reason="no rm", commands=("rm", ))
    ask = CommandRule(reason="wip nod", commands=("rm", ), paths=("/wip/*", ))
    rules = AdmissionRules(ask=(ask, ), deny=(pathless, ))
    assert decide(_ctx("rm", "/wip/x"), rules).rule is ask
    assert decide(_ctx("rm", "/wip/x", "/elsewhere"), rules).rule is pathless
    # A line naming no path at all is one subject, itself.
    whole = decide(_ctx("rm"), rules)
    assert whole.rule is pathless
    assert whole.matched_path is None


def test_the_decision_reports_the_rule_and_where_it_was_written():
    top = CommandRule(reason="top", commands=("rm", ), paths=("/a/*", ))
    inside = CommandRule(reason="mount",
                         commands=("rm", ),
                         paths=("/a/b/*", ),
                         mount="/a")
    decision = decide(_ctx("rm", "/a/b/x"), AdmissionRules(deny=(top, inside)))
    assert decision.rule is inside
    assert decision.source == "mounts./a"
    assert source_of(top) == "top"


def test_outranks_reads_the_verb_first_where_better_match_reads_depth():
    # Two subjects of one line are a question of severity, so a deny at
    # depth 0 outranks an ask at depth 3.
    assert outranks((ASK_SECOND, 3), DENY_FIRST, 0)
    assert not outranks((DENY_FIRST, 0), ASK_SECOND, 3)
    assert outranks((DENY_FIRST, 1), DENY_FIRST, 2)
    assert not outranks((DENY_FIRST, 2), DENY_FIRST, 2)


def test_every_subjects_ask_is_reported_not_just_the_winner():
    source = CommandRule(reason="source nod",
                         commands=("cp", ),
                         paths=("/a/*", ))
    dest = CommandRule(reason="dest nod",
                       commands=("cp", ),
                       paths=("/deep/b/*", ))
    rules = AdmissionRules(ask=(source, dest))
    decision = decide(_ctx("cp", "/a/x", "/deep/b/y"), rules)
    # The deeper anchor is still the decision, which is what the agent is
    # told; both are what the door has to collect.
    assert decision.outcome is Outcome.ASK
    assert decision.rule is dest
    assert decision.asks == (source, dest)
    # One rule covering two operands is one question, not two.
    both = CommandRule(reason="either", commands=("cp", ), paths=("/a/*", ))
    one = decide(_ctx("cp", "/a/x", "/a/y"), AdmissionRules(ask=(both, )))
    assert one.asks == (both, )
    # A deny anywhere refuses the line, so there is nothing to ask about.
    stopped = decide(
        _ctx("cp", "/a/x", "/deep/b/y"),
        AdmissionRules(ask=(dest, ),
                       deny=(CommandRule(reason="no",
                                         commands=("cp", ),
                                         paths=("/a/*", )), )))
    assert stopped.outcome is Outcome.DENY
    assert stopped.asks == ()
