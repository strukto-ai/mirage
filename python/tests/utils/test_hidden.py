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

from mirage.types import (
    HiddenPaths,
    HiddenVars,
    MountMode,
    ShowEntry,
    Visibility,
)
from mirage.utils.hidden import (
    classify_paths,
    classify_shows,
    hidden_under,
    hide_depth,
    move_reveals,
    path_covers,
    path_hidden,
    path_visible,
    show_depth,
    show_head,
    shown_mode,
    var_hidden,
)


def _vis(hide: list[str], show: tuple[ShowEntry, ...] = ()) -> Visibility:
    return Visibility(paths=classify_paths(hide), shown=classify_shows(show))


def test_none_hides_nothing():
    assert path_hidden(None, "/a/b") is False
    assert var_hidden(None, "SECRET") is False


def test_empty_spec_hides_nothing():
    assert path_hidden(HiddenPaths(), "/a/b") is False
    assert var_hidden(Visibility(vars=HiddenVars()), "SECRET") is False


def test_exact_path_hides_itself_and_its_subtree():
    # A name you cannot see cannot be a parent you traverse, so hiding
    # a path always hides everything under it.
    h = HiddenPaths(paths=("/s3/secrets",))
    assert path_hidden(h, "/s3/secrets")
    assert path_hidden(h, "/s3/secrets/a.txt")
    assert path_hidden(h, "/s3/secrets/deep/b")
    assert not path_hidden(h, "/s3")
    assert not path_hidden(h, "/s3/secretsfoo")
    assert not path_hidden(h, "/s3/other")


def test_exact_path_spelling_is_normalized():
    assert path_hidden(HiddenPaths(paths=("/s3/secrets/",)), "/s3/secrets")
    assert path_hidden(HiddenPaths(paths=("s3/secrets",)), "/s3/secrets/a")


def test_exact_path_at_a_mount_root_covers_the_mount():
    # Subtractive mount hiding is a one-line prefix entry; the grant
    # table (mount_modes) stays the additive spelling.
    h = HiddenPaths(paths=("/s3",))
    assert path_hidden(h, "/s3")
    assert path_hidden(h, "/s3/any/depth")
    assert not path_hidden(h, "/other")


def test_component_pattern_applies_inside_every_mount():
    # A pattern with no "/" matches any single name component, so
    # "hide *.key everywhere" is one entry, not one per mount.
    h = HiddenPaths(patterns=("*.key",))
    assert path_hidden(h, "/a/b.key")
    assert path_hidden(h, "/other/deep/c.key")
    assert path_hidden(h, "/a/b.key/inside.txt")
    assert not path_hidden(h, "/a/bkey")
    assert not path_hidden(h, "/a/keyed")


def test_anchored_pattern_matches_the_full_virtual_path():
    h = HiddenPaths(patterns=("/config/*.pem",))
    assert path_hidden(h, "/config/x.pem")
    assert path_hidden(h, "/config/x.pem/sub")
    assert not path_hidden(h, "/other/x.pem")


def test_anchored_star_crosses_slashes_like_find_path():
    # Deliberate: fnmatch's "*" is not slash-aware, the same semantics
    # GNU find -path applies to its patterns.
    h = HiddenPaths(patterns=("/config/*.pem",))
    assert path_hidden(h, "/config/nested/x.pem")


def test_patterns_share_the_repo_fnmatch_dialect():
    # [^...] negates like [!...] (bash/glibc), because the matcher is
    # utils/fnmatch, not stdlib fnmatch.
    h = HiddenPaths(patterns=("[^a]*.key",))
    assert path_hidden(h, "/x/b.key")
    assert not path_hidden(h, "/x/a.key")


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


def test_classify_vars_splits_globs_from_names():
    from mirage.utils.hidden import classify_vars

    assert classify_vars(["SLACK_TOKEN", "AWS_*"]) == HiddenVars(
        names=("SLACK_TOKEN",), patterns=("AWS_*",)
    )
    assert classify_vars([]) is None


def test_classified_entries_match_like_the_hand_built_spec():
    from mirage.utils.hidden import classify_paths

    spec = classify_paths(["/s3/secrets", "*.key", "/repo/docs/*"])
    assert path_hidden(spec, "/s3/secrets/deep/b")
    assert path_hidden(spec, "/a/b.key/c")
    assert path_hidden(spec, "/repo/docs/x/y")
    assert not path_hidden(spec, "/repo/docsx")


def test_path_covers_is_the_directory_holding_the_scope_or_an_ancestor():
    spec = HiddenPaths(
        paths=("/s3/secrets",), patterns=("/repo/docs/*", "*.pem")
    )
    # An exact entry is covered by itself and by every ancestor; an
    # anchored pattern by its fixed head and that head's ancestors.
    for virtual in ("/s3/secrets", "/s3", "/", "/repo/docs", "/repo"):
        assert path_covers(spec, virtual)
    for virtual in ("/s3/secrets/a", "/s3/other", "/repo/docs/x", "/x"):
        assert not path_covers(spec, virtual)
    # Without ancestors only the holding directory counts (a destination).
    assert path_covers(spec, "/repo/docs", ancestors=False)
    assert not path_covers(spec, "/repo", ancestors=False)
    # A component pattern names no place, so nothing is covered by it.
    assert not path_covers(HiddenPaths(paths=(), patterns=("*.pem",)), "/x")
    assert not path_covers(None, "/")


def test_hide_depth_scores_the_entry_never_the_match_site():
    spec = classify_paths(["/repo", "/repo/sealed/*", "*.pem"])
    # The exact subtree scores its component count wherever it matched.
    assert hide_depth(spec, "/repo/a/b/c") == 1
    # The anchored pattern covers descendants through the matched
    # ancestor and still scores its own anchor depth.
    assert hide_depth(spec, "/repo/sealed/x/deep") == 2
    # A component pattern anchors nothing.
    assert hide_depth(classify_paths(["*.pem"]), "/x/k.pem/y") == 0
    assert hide_depth(spec, "/other") is None
    assert hide_depth(None, "/repo") is None


def test_show_depth_covers_the_entry_subtree():
    shown = classify_shows(
        [
            ShowEntry("/repo/public"),
            ShowEntry("/repo/docs/*", MountMode.READ),
        ]
    )
    assert show_depth(shown, "/repo/public/index.html") == 2
    assert show_depth(shown, "/repo/public") == 2
    assert show_depth(shown, "/repo/docs/a/b") == 2
    # The pattern's fixed head itself is not matched by fnmatch, and an
    # entry covers nothing above its anchor.
    assert show_depth(shown, "/repo") is None
    assert show_depth(None, "/repo/public") is None
    # A stray slashless pattern from a typed constructor covers
    # nothing, failing toward refusal.
    assert show_depth(classify_shows([ShowEntry("*.md")]), "/a/x.md") is None


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


def test_shown_mode_is_the_deepest_mode_entry():
    shown = classify_shows(
        [
            ShowEntry("/repo", MountMode.READ),
            ShowEntry("/repo/build", MountMode.WRITE),
            ShowEntry("/repo/public"),
        ]
    )
    assert shown_mode(shown, "/repo/src/a.py") == (1, MountMode.READ)
    assert shown_mode(shown, "/repo/build/out") == (2, MountMode.WRITE)
    # A list-form entry states visibility only.
    assert shown_mode(shown, "/repo/public/x") == (1, MountMode.READ)
    assert shown_mode(shown, "/elsewhere") is None
    assert shown_mode(None, "/repo") is None


def test_shown_mode_equal_depth_takes_the_weaker():
    shown = classify_shows(
        [
            ShowEntry("/repo/docs", MountMode.EXEC),
            ShowEntry("/repo/*", MountMode.READ),
        ]
    )
    assert shown_mode(shown, "/repo/docs/a") == (2, MountMode.EXEC)
    # Both anchor at depth 1 for a path only the pattern reaches; a
    # second depth-1 statement can only weaken the first.
    both = classify_shows(
        [
            ShowEntry("/repo", MountMode.EXEC),
            ShowEntry("/repo/*", MountMode.READ),
        ]
    )
    assert shown_mode(both, "/repo/x") == (1, MountMode.READ)


def test_classify_shows_empty_is_none():
    assert classify_shows([]) is None
    assert classify_shows([ShowEntry("/a")]) is not None


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
