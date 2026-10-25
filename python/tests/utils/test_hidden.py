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

import pytest

from mirage.types import (
    HiddenPaths,
    HiddenVars,
    MountMode,
    ShowEntry,
    ShownPaths,
    Visibility,
)
from mirage.utils.hidden import (
    classify_paths,
    hidden_under,
    leads_hidden,
    move_reveals,
    path_visible,
    show_head,
    var_hidden,
    visible_links,
)
from mirage.utils.path import CycleError, resolve_symlinks


def _vis(hide: list[str], show: tuple[ShowEntry, ...] = ()) -> Visibility:
    return Visibility(
        paths=classify_paths(hide),
        shown=ShownPaths(entries=show) if show else None,
    )


def test_none_hides_nothing():
    assert path_visible(None, "/a/b") is True
    assert var_hidden(None, "SECRET") is False


def test_empty_spec_hides_nothing():
    assert path_visible(Visibility(paths=HiddenPaths()), "/a/b") is True
    assert var_hidden(Visibility(vars=HiddenVars()), "SECRET") is False


def test_var_names_are_exact():
    vis = Visibility(vars=HiddenVars(names=("SLACK_TOKEN",)))
    assert var_hidden(vis, "SLACK_TOKEN")
    assert not var_hidden(vis, "SLACK_TOKEN2")
    assert not var_hidden(vis, "PATH")


def test_var_patterns_are_globs_over_names():
    vis = Visibility(vars=HiddenVars(patterns=("AWS_*", "*_SECRET")))
    assert var_hidden(vis, "AWS_ACCESS_KEY_ID")
    assert var_hidden(vis, "DB_SECRET")
    assert not var_hidden(vis, "HOME")


def test_classify_paths_splits_globs_from_exact_subtrees():
    from mirage.utils.hidden import classify_paths

    assert classify_paths(
        ["/repo/.env", "*.pem", "/repo/docs/*", "secrets"]
    ) == HiddenPaths(
        paths=("/repo/.env", "secrets"), patterns=("*.pem", "/repo/docs/*")
    )
    assert classify_paths(["/a/b[1]"]) == HiddenPaths(patterns=("/a/b[1]",))
    assert classify_paths(["/a/?"]) == HiddenPaths(patterns=("/a/?",))


def test_classify_paths_empty_is_unrestricted():
    from mirage.utils.hidden import classify_paths

    assert classify_paths([]) is None
    assert classify_paths(()) is None


def test_classified_entries_match_like_the_hand_built_spec():

    spec = _vis(["/s3/secrets", "*.key", "/repo/docs/*"])
    assert not path_visible(spec, "/s3/secrets/deep/b")
    assert not path_visible(spec, "/a/b.key/c")
    assert not path_visible(spec, "/repo/docs/x/y")
    assert path_visible(spec, "/repo/docsx")


def test_show_head_is_the_anchor():
    assert show_head("/repo/public") == "/repo/public"
    assert show_head("/repo/docs/*") == "/repo/docs"
    assert show_head("/repo/*/x") == "/repo"


def test_path_visible_is_the_anchor_depth_rule():
    vis = _vis(["/repo"], (ShowEntry("/repo/public", MountMode.READ),))
    # The deeper show re-opens its subtree.
    assert path_visible(vis, "/repo/public/index.html")
    assert path_visible(vis, "/repo/public")
    # Everything else under the hide stays nonexistent.
    assert not path_visible(vis, "/repo/secrets/key.pem")
    assert not path_visible(vis, "/repo/README.md")
    # No hide, always visible; no show, plain hiding.
    assert path_visible(Visibility(shown=vis.shown), "/anywhere")
    assert not path_visible(Visibility(paths=vis.paths), "/repo/x")


def test_hide_wins_the_equal_depth_tie():
    vis = _vis(["/repo/public"], (ShowEntry("/repo/public", MountMode.READ),))
    assert not path_visible(vis, "/repo/public/x")


def test_deeper_hide_re_closes_inside_a_show():
    vis = _vis(["/repo", "/repo/public/sealed"], (ShowEntry("/repo/public"),))
    assert path_visible(vis, "/repo/public/a.txt")
    assert not path_visible(vis, "/repo/public/sealed/k")


def test_show_outranks_a_name_pattern_only_inside_its_anchor():
    vis = _vis(["*.pem"], (ShowEntry("/repo/public"),))
    assert path_visible(vis, "/repo/public/tls.pem")
    assert not path_visible(vis, "/other/tls.pem")


def test_ancestors_of_a_show_anchor_stay_visible():
    # The road to the carve-out exists: `ls /repo` lists `public` even
    # though `/repo` itself lies under the hide.
    vis = _vis(["/repo"], (ShowEntry("/repo/public/docs"),))
    for virtual in ("/", "/repo", "/repo/public"):
        assert path_visible(vis, virtual)
    assert not path_visible(vis, "/repo/other")


def test_a_hidden_show_anchor_opens_no_road():
    # The show anchor is itself re-hidden at equal depth, so nothing
    # above it gains visibility from it.
    vis = _vis(["/repo", "/repo/public"], (ShowEntry("/repo/public"),))
    assert not path_visible(vis, "/repo")
    assert not path_visible(vis, "/repo/public/x")


def test_hidden_under_is_the_per_operand_gate():
    spec = _vis(["/repo/.env"])
    # The walk that could reach the entry loses its fast path...
    assert hidden_under(spec, "/repo")
    assert hidden_under(spec, "/")
    assert hidden_under(spec, "/repo/.env")
    # ...and a sibling mount keeps its native op.
    assert not hidden_under(spec, "/s3")
    assert not hidden_under(spec, "/repo/open")
    # A component pattern names no place, so it intersects everything.
    assert hidden_under(_vis(["*.pem"]), "/s3")
    # An anchored pattern intersects through its fixed head, and inside
    # its own subtree.
    sealed = _vis(["/repo/sealed/*"])
    assert hidden_under(sealed, "/repo")
    assert hidden_under(sealed, "/repo/sealed/x")
    assert not hidden_under(sealed, "/repo/open")
    assert not hidden_under(None, "/")


def test_hidden_under_counts_an_operand_below_a_patterns_head():
    # The wildcard tail can match anywhere under the fixed head, so a
    # walk of any subtree below it may hold matches (`/repo/*/secret`
    # covers `/repo/public/secret`), even though the operand itself is
    # neither hidden nor an ancestor of the head.
    spec = _vis(["/repo/*/secret"])
    assert hidden_under(spec, "/repo/public")
    assert hidden_under(spec, "/repo/public/deep")
    assert hidden_under(spec, "/repo")
    assert not hidden_under(spec, "/other")


def test_a_globbed_show_keeps_its_anchor_traversable():
    # `hide /repo` + `show /repo/public/*`: the matches score the
    # anchor's depth, so the anchor directory and the road above it
    # answer by the same compare instead of staying hidden around
    # visible children.
    vis = _vis(["/repo"], (ShowEntry("/repo/public/*"),))
    assert path_visible(vis, "/repo/public/index.html")
    assert path_visible(vis, "/repo/public")
    assert path_visible(vis, "/repo")
    assert not path_visible(vis, "/repo/secrets")
    # A hide at the anchor's own depth still wins the tie.
    rehidden = _vis(["/repo", "/repo/public"], (ShowEntry("/repo/public/*"),))
    assert not path_visible(rehidden, "/repo/public")
    assert not path_visible(rehidden, "/repo/public/index.html")


def test_move_reveals_an_exact_entry_below_the_source():
    # /m/data/secret re-anchors to /m/moved/secret, which nothing hides.
    spec = _vis(["/m/data/secret"])
    assert move_reveals(spec, "/m/data", "/m/moved")
    # An entry not below the source moves nothing.
    assert not move_reveals(spec, "/m/other", "/m/moved")
    # The entry itself is the source: the operand is hidden and the
    # per-path guard answered before this predicate is asked.
    assert not move_reveals(spec, "/m/data/secret/deep", "/m/x")
    assert not move_reveals(None, "/m/data", "/m/moved")


def test_move_does_not_reveal_when_the_mapped_path_stays_hidden():
    spec = _vis(["/m/d/sec", "/m/moved/sec"])
    assert not move_reveals(spec, "/m/d", "/m/moved")
    assert move_reveals(spec, "/m/d", "/m/elsewhere")


def test_component_patterns_follow_the_name_and_never_reveal():
    spec = _vis(["*.env"])
    assert not move_reveals(spec, "/m/d", "/m/moved")


def test_anchored_patterns_refuse_toward_refusal():
    # The pattern's coverage does not move with the content, and its
    # match space cannot be enumerated, so any pattern that could reach
    # below the source refuses: head at the source, below it, or above
    # it with the wildcard region spanning the source.
    for hide in ("/m/d/sec/*", "/m/d/*", "/m/*/secret"):
        assert move_reveals(_vis([hide]), "/m/d", "/m/moved")
    assert not move_reveals(_vis(["/other/*/secret"]), "/m/d", "/m/moved")


def test_a_show_below_the_mapped_path_counts_as_a_reveal():
    # The mapped anchor lands hidden under /m/moved, but a visible show
    # anchored strictly below it re-opens a road in, which pathVisible's
    # carve-out rule reports as visibility.
    vis = _vis(["/m/d/sec", "/m/moved"], (ShowEntry("/m/moved/sec/open"),))
    assert move_reveals(vis, "/m/d", "/m/moved")
    assert not move_reveals(Visibility(paths=vis.paths), "/m/d", "/m/moved")


def test_a_source_reached_through_a_show_reveals_what_it_leaves_hidden():
    # /m/box is hidden and reached only through its shown pub.txt, so the
    # rest of it sits under a hide that does not move with it.
    shown = (ShowEntry("/m/box/pub.txt"),)
    assert move_reveals(_vis(["/m/box"], shown), "/m/box", "/v/mb")
    assert move_reveals(_vis(["/m"], shown), "/m/box", "/v/mb")
    # Into a place the session does not see, nothing comes into view.
    assert not move_reveals(_vis(["/m/box", "/v"], shown), "/m/box", "/v/mb")
    # A show at the source reopens all of it.
    assert not move_reveals(
        _vis(["/m"], (ShowEntry("/m/box"),)), "/m/box", "/v/mb"
    )


LINKS = {
    "/data/shared/to_secret": "/data/secret/f",
    "/data/shared/rel_secret": "../secret/f",
    "/data/shared/dirlink": "/data/secret",
    "/data/shared/chain": "/data/shared/to_secret",
    "/data/shared/to_pub": "/data/pub/n.txt",
    "/data/shared/dangling": "/data/nope",
    "/data/shared/loop": "/data/shared/loop",
    "/data/shared/through": "/data/secret/../pub/n.txt",
    "/data/alias": "/data/secret",
    "/data/shared/via_alias": "/data/alias/f",
}


def test_leads_hidden_follows_a_link_into_hidden_space():
    vis = _vis(["/data/secret"])
    for path in (
        "/data/shared/to_secret",
        "/data/shared/rel_secret",
        "/data/shared/dirlink",
        "/data/shared/dirlink/f",
        "/data/shared/chain",
        "/data/shared/through",
        "/data/shared/via_alias",
    ):
        assert leads_hidden(vis, path, LINKS), path
    for path in (
        "/data/shared/to_pub",
        "/data/shared/dangling",
        "/data/shared/loop",
        "/data/pub/n.txt",
    ):
        assert not leads_hidden(vis, path, LINKS), path


def test_leads_hidden_judges_what_a_link_brings_in_not_the_typed_path():
    carved = _vis(["*.key"], (ShowEntry("/repo/*/public"),))
    links = {"/other/l": "/x", "/repo/alias": "/repo/dir.key/public"}
    assert path_visible(carved, "/repo/dir.key/public/f.txt")
    assert not leads_hidden(carved, "/repo/dir.key/public/f.txt", links)
    assert not leads_hidden(carved, "/repo/alias/f.txt", links)


def test_leads_hidden_needs_a_hide_and_a_link():
    assert not leads_hidden(None, "/data/shared/to_secret", LINKS)
    assert not leads_hidden(_vis([]), "/data/shared/to_secret", LINKS)
    assert not leads_hidden(
        _vis(["/data/secret"]), "/data/shared/to_secret", {}
    )


def test_leads_hidden_reads_only_reached_links_and_observes_mutation():
    class LookupLinks(dict[str, str]):
        def items(self):
            raise AssertionError(
                "Unrelated link entries must not be enumerated"
            )

    links = LookupLinks(
        {f"/unused{index}": "/public" for index in range(10000)}
    )
    links["/link"] = "/public"
    assert not leads_hidden(_vis(["/secret"]), "/link", links)
    links["/link"] = "/secret"
    assert leads_hidden(_vis(["/secret"]), "/link", links)


@pytest.mark.parametrize("target", ("", ".", "./", "/./"))
def test_leads_hidden_keeps_effective_parent_steps_after_empty_targets(target):
    links = {"/link": target}
    path = "/link/secret/./..//public/"
    assert resolve_symlinks(path, links) == "/public/"
    assert leads_hidden(_vis(["/secret"]), path, links)


def test_leads_hidden_checks_the_link_name_before_the_hop_limit():
    links = {f"/link{index}": f"/link{index + 1}" for index in range(41)}
    assert leads_hidden(_vis(["/link40"]), "/link0", links)
    assert not leads_hidden(_vis(["/elsewhere"]), "/link0", links)
    with pytest.raises(CycleError):
        resolve_symlinks("/link0", links)


def test_link_exposure_propagates_lookup_errors():
    class ErrorLinks(dict[str, str]):
        def get(self, key, default=None):
            raise CycleError("/caller")

    with pytest.raises(CycleError) as failure:
        leads_hidden(
            _vis(["/secret"]), "/link", ErrorLinks({"/link": "/public"})
        )
    assert failure.value.filename == "/caller"


def test_link_batches_keep_order_and_surrogate_target_text():
    links = {"/link\ud800": "/secret\ud800/../public"}
    scope = _vis(["/secret\ud800"])
    assert resolve_symlinks("/link\ud800/", links) == "/public/"
    assert visible_links(
        scope, ("/link\ud800", "/public", "/secret\ud800/key"), links
    ) == (False, True, False)
    links["/link\ud800"] = "/public"
    assert visible_links(scope, ("/link\ud800",), links) == (True,)


def test_hidden_link_targets_are_not_inspected():
    lookups: list[str] = []

    class LookupLinks(dict[str, str]):
        def get(self, key, default=None):
            lookups.append(key)
            if key == "/secret/link":
                raise AssertionError(
                    "Hidden link targets must not be inspected"
                )
            return super().get(key, default)

    links = LookupLinks({"/secret/link": "/x"})
    assert visible_links(
        _vis(["/secret"]), ("/secret/link", "/public"), links
    ) == (False, True)
    assert "/secret/link" not in lookups
