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

# git prints usage errors at tree levels with exit 129; leaf spec errors
# keep the GNU exit-2 machinery they already ride.
USAGE_EXIT = 129

# clap exits 2 for a usage error at every level of its tree, agreeing
# with argparse by coincidence rather than by lineage. It lives here
# rather than beside the refusal renderers because the walk reads it
# too, and the walk cannot import a module that reaches the workspace.
CLAP_EXIT = 2

# The environment variable carrying an install's config to a script CLI
# (JSON). Deliberately not MIRAGE_CONFIG: that one already names the
# workspace config file for the server and mcp entry points, and a
# script CLI that shells back into mirage must not find a config blob
# where a path belongs.
CLI_CONFIG_ENV = "MIRAGE_CLI_CONFIG"

# git's own long options for each parse-options verb mirage implements, in
# git's table order and its `--[no-]` notation, captured from
# `git <verb> --help-all` (config's legacy table from its usage listing) on
# git 2.50.1. Under git's usage style a leaf resolves an abbreviated long
# option against its verb's table the way parse-options does, so a prefix
# git finds ambiguous is refused even where mirage declares only one of the
# options it could be. A git verb with no table (log, show, diff, rev-list,
# diff-tree: the revision walkers) takes whole words only, as git's
# revision parser does.
GIT_LONG_OPTIONS: dict[str, tuple[str, ...]] = {
    "add": (
        "[no-]dry-run",
        "[no-]verbose",
        "[no-]interactive",
        "[no-]patch",
        "[no-]edit",
        "[no-]force",
        "[no-]update",
        "[no-]renormalize",
        "[no-]intent-to-add",
        "[no-]all",
        "[no-]ignore-removal",
        "[no-]refresh",
        "[no-]ignore-errors",
        "[no-]ignore-missing",
        "[no-]sparse",
        "[no-]chmod",
        "[no-]warn-embedded-repo",
        "[no-]pathspec-from-file",
        "[no-]pathspec-file-nul",
    ),
    "branch": (
        "[no-]verbose",
        "[no-]quiet",
        "[no-]track",
        "[no-]set-upstream",
        "[no-]set-upstream-to",
        "[no-]unset-upstream",
        "[no-]color",
        "remotes",
        "contains",
        "no-contains",
        "with",
        "without",
        "[no-]abbrev",
        "all",
        "[no-]delete",
        "[no-]move",
        "[no-]omit-empty",
        "[no-]copy",
        "[no-]list",
        "[no-]show-current",
        "[no-]create-reflog",
        "[no-]edit-description",
        "[no-]force",
        "merged",
        "no-merged",
        "[no-]column",
        "[no-]sort",
        "[no-]points-at",
        "[no-]ignore-case",
        "[no-]recurse-submodules",
        "[no-]format",
    ),
    "checkout": (
        "[no-]guess",
        "[no-]overlay",
        "[no-]quiet",
        "[no-]recurse-submodules",
        "[no-]progress",
        "[no-]merge",
        "[no-]conflict",
        "[no-]detach",
        "[no-]track",
        "[no-]force",
        "[no-]orphan",
        "[no-]overwrite-ignore",
        "[no-]ignore-other-worktrees",
        "ours",
        "theirs",
        "[no-]patch",
        "[no-]ignore-skip-worktree-bits",
        "[no-]pathspec-from-file",
        "[no-]pathspec-file-nul",
    ),
    "commit": (
        "[no-]quiet",
        "[no-]verbose",
        "[no-]file",
        "[no-]author",
        "[no-]date",
        "[no-]message",
        "[no-]reedit-message",
        "[no-]reuse-message",
        "[no-]fixup",
        "[no-]squash",
        "[no-]reset-author",
        "trailer",
        "[no-]signoff",
        "[no-]template",
        "[no-]edit",
        "[no-]cleanup",
        "[no-]status",
        "[no-]gpg-sign",
        "[no-]all",
        "[no-]include",
        "[no-]interactive",
        "[no-]patch",
        "[no-]only",
        "no-verify",
        "verify",
        "[no-]dry-run",
        "[no-]short",
        "[no-]branch",
        "[no-]ahead-behind",
        "[no-]porcelain",
        "[no-]long",
        "[no-]null",
        "[no-]amend",
        "no-post-rewrite",
        "post-rewrite",
        "[no-]untracked-files",
        "[no-]pathspec-from-file",
        "[no-]pathspec-file-nul",
        "[no-]allow-empty",
        "[no-]allow-empty-message",
    ),
    "config": (
        "[no-]global",
        "[no-]system",
        "[no-]local",
        "[no-]worktree",
        "[no-]file",
        "[no-]blob",
        "get",
        "get-all",
        "get-regexp",
        "get-urlmatch",
        "replace-all",
        "add",
        "unset",
        "unset-all",
        "rename-section",
        "remove-section",
        "list",
        "edit",
        "get-color",
        "get-colorbool",
        "[no-]null",
        "[no-]name-only",
        "[no-]show-origin",
        "[no-]show-scope",
        "[no-]show-names",
        "[no-]type",
        "bool",
        "int",
        "bool-or-int",
        "bool-or-str",
        "path",
        "expiry-date",
        "[no-]default",
        "[no-]comment",
        "[no-]fixed-value",
        "[no-]includes",
    ),
    "for-each-ref": (
        "[no-]shell",
        "[no-]perl",
        "[no-]python",
        "[no-]tcl",
        "[no-]omit-empty",
        "[no-]count",
        "[no-]format",
        "[no-]color",
        "[no-]exclude",
        "[no-]sort",
        "[no-]points-at",
        "merged",
        "no-merged",
        "contains",
        "no-contains",
        "[no-]ignore-case",
        "[no-]stdin",
        "[no-]include-root-refs",
    ),
    "mv": (
        "[no-]verbose",
        "[no-]dry-run",
        "[no-]force",
        "[no-]sparse",
    ),
    "remote": ("[no-]verbose",),
    "remote get-url": ("[no-]push", "[no-]all"),
    "reset": (
        "[no-]quiet",
        "no-refresh",
        "refresh",
        "mixed",
        "soft",
        "hard",
        "merge",
        "keep",
        "[no-]recurse-submodules",
        "[no-]patch",
        "[no-]intent-to-add",
        "[no-]pathspec-from-file",
        "[no-]pathspec-file-nul",
    ),
    "restore": (
        "[no-]source",
        "[no-]staged",
        "[no-]worktree",
        "[no-]ignore-unmerged",
        "[no-]overlay",
        "[no-]quiet",
        "[no-]recurse-submodules",
        "[no-]progress",
        "[no-]merge",
        "[no-]conflict",
        "ours",
        "theirs",
        "[no-]patch",
        "[no-]ignore-skip-worktree-bits",
        "[no-]pathspec-from-file",
        "[no-]pathspec-file-nul",
    ),
    "rm": (
        "[no-]dry-run",
        "[no-]quiet",
        "[no-]cached",
        "[no-]force",
        "[no-]ignore-unmatch",
        "[no-]sparse",
        "[no-]pathspec-from-file",
        "[no-]pathspec-file-nul",
    ),
    "show-ref": (
        "[no-]tags",
        "[no-]branches",
        "[no-]heads",
        "[no-]exists",
        "[no-]verify",
        "[no-]head",
        "[no-]dereference",
        "[no-]hash",
        "[no-]abbrev",
        "[no-]quiet",
        "exclude-existing",
    ),
    "status": (
        "[no-]verbose",
        "[no-]short",
        "[no-]branch",
        "[no-]show-stash",
        "[no-]ahead-behind",
        "[no-]porcelain",
        "[no-]long",
        "[no-]null",
        "[no-]untracked-files",
        "[no-]ignored",
        "[no-]ignore-submodules",
        "[no-]column",
        "no-renames",
        "renames",
        "find-renames",
    ),
    "switch": (
        "[no-]create",
        "[no-]force-create",
        "[no-]guess",
        "[no-]discard-changes",
        "[no-]quiet",
        "[no-]recurse-submodules",
        "[no-]progress",
        "[no-]merge",
        "[no-]conflict",
        "[no-]detach",
        "[no-]track",
        "[no-]force",
        "[no-]orphan",
        "[no-]overwrite-ignore",
        "[no-]ignore-other-worktrees",
    ),
    "symbolic-ref": (
        "[no-]quiet",
        "[no-]delete",
        "[no-]short",
        "[no-]recurse",
    ),
    "tag": (
        "list",
        "delete",
        "verify",
        "[no-]annotate",
        "message",
        "[no-]file",
        "trailer",
        "[no-]edit",
        "[no-]sign",
        "[no-]cleanup",
        "[no-]local-user",
        "[no-]force",
        "[no-]create-reflog",
        "[no-]column",
        "contains",
        "no-contains",
        "with",
        "without",
        "merged",
        "no-merged",
        "[no-]omit-empty",
        "[no-]sort",
        "[no-]points-at",
        "[no-]format",
        "[no-]color",
        "[no-]ignore-case",
    ),
    "version": ("[no-]build-options",),
}

# The synopsis lines git's usage block opens with, keyed like
# GIT_LONG_OPTIONS ("" is the bare `git`). git's own lines, pinned on git
# 2.47.3, cut down to the forms mirage implements; the option rows under
# them are rendered from each leaf's spec, so the block never lists what
# mirage would refuse. A line holding a newline is one git wraps itself.
GIT_SYNOPSES: dict[str, tuple[str, ...]] = {
    "": (
        "git [-v | --version] [--help] [-C <path>] [--git-dir=<path>]\n"
        "           [--work-tree=<path>] <command> [<args>]",
    ),
    "add": ("git add [<options>] [--] <pathspec>...",),
    "cat-file": (
        "git cat-file <type> <object>",
        "git cat-file (-e | -p | -t | -s) <object>",
        "git cat-file (--textconv | --filters)\n"
        "                    [<rev>:<path|tree-ish> | --path=<path|tree-ish> <rev>]",
        "git cat-file (--batch | --batch-check | --batch-command) "
        "[--batch-all-objects]\n"
        "                    [--buffer] [--follow-symlinks] [--unordered]\n"
        "                    [--textconv | --filters] [-Z]",
    ),
    "branch": (
        "git branch [<options>] [-r | -a] [--merged] [--no-merged]",
        "git branch [<options>] <branch-name> [<start-point>]",
        "git branch [<options>] [-l] [<pattern>...]",
        "git branch [<options>] [-r] (-d | -D) <branch-name>...",
        "git branch [<options>] [-r | -a] [--points-at]",
        "git branch [<options>] [-r | -a] [--format]",
    ),
    "checkout": (
        "git checkout [<options>] <branch>",
        "git checkout [<options>] [<branch>] -- <file>...",
    ),
    "clone": ("git clone [<options>] [--] <repo> [<dir>]",),
    "commit": (
        "git commit [-a] [-q] [-m <msg>] [--allow-empty] [--author=<author>]",
    ),
    "config": (
        "git config [--global] [--show-origin] (-l | --list)",
        "git config [--global] [--show-origin] [--get] <name>",
        "git config [--global] [--show-origin] --get-regexp <name-regex>",
    ),
    "diff": (
        "git diff [<options>] [<commit>] [--] [<path>...]",
        "git diff [<options>] --cached [<commit>] [--] [<path>...]",
        "git diff [<options>] <commit> <commit> [--] [<path>...]",
        "git diff [<options>] <commit>...<commit> [--] [<path>...]",
    ),
    "diff-tree": ("git diff-tree [<options>] <tree-ish> [<path>...]",),
    "fetch": ("git fetch [<options>] [<repository> [<refspec>...]]",),
    "for-each-ref": (
        "git for-each-ref [<options>] [<pattern>]",
        "git for-each-ref [--points-at <object>]",
        "git for-each-ref [--merged [<commit>]] [--no-merged [<commit>]]",
        "git for-each-ref [--contains [<commit>]] [--no-contains [<commit>]]",
    ),
    "fsck": ("git fsck [--full] [--no-dangling]",),
    "help": ("git help [<command>]",),
    "init": (
        "git init [-q | --quiet] [--bare]\n"
        "                [-b <branch-name> | --initial-branch=<branch-name>]\n"
        "                [<directory>]",
    ),
    "log": (
        "git log [<options>] [<revision-range>] [[--] <path>...]",
        "git show [<options>] <object>...",
    ),
    "ls-files": ("git ls-files [<options>] [<file>...]",),
    "mv": ("git mv [<options>] <source>... <destination>",),
    "reflog": ("git reflog [show] [<log-options>] [<ref>]",),
    "remote": ("git remote [-v | --verbose]",),
    "remote get-url": ("git remote get-url [--push] [--all] <name>",),
    "reset": (
        "git reset [-q] [<commit>]",
        "git reset [-q] [<tree-ish>] [--] <pathspec>...",
    ),
    "restore": ("git restore [<options>] [--source=<branch>] <file>...",),
    "rev-list": ("git rev-list [<options>] <commit>... [--] [<path>...]",),
    "rev-parse": ("git rev-parse [<options>] [<arg>...]",),
    "rm": (
        "git rm [-f | --force] [-r] [--cached] [--ignore-unmatch]\n"
        "              [--quiet] [--] [<pathspec>...]",
    ),
    "shortlog": (
        "git shortlog [<options>] [<revision-range>] [[--] <path>...]",
    ),
    "show": (
        "git log [<options>] [<revision-range>] [[--] <path>...]",
        "git show [<options>] <object>...",
    ),
    "show-ref": ("git show-ref [--] [<pattern>...]",),
    "stash": ("git stash list", "git stash show [<diff-options>] [<stash>]"),
    "stash list": ("git stash list",),
    "stash show": ("git stash show [<diff-options>] [<stash>]",),
    "status": ("git status [<options>]",),
    "switch": ("git switch [<options>] [<branch>]",),
    "hash-object": (
        "git hash-object [-t <type>] [-w] [--path=<file> | --no-filters]\n"
        "                       [--stdin [--literally]] [--] <file>...",
        "git hash-object [-t <type>] [-w] --stdin-paths [--no-filters]",
    ),
    "symbolic-ref": (
        "git symbolic-ref [-m <reason>] <name> <ref>",
        "git symbolic-ref [-q] [--short] [--no-recurse] <name>",
        "git symbolic-ref --delete [-q] <name>",
    ),
    "tag": (
        "git tag [-a] [-f] [-m <msg>] <tagname> [<commit> | <object>]",
        "git tag -d <tagname>...",
        "git tag [-n[<num>]] -l [--contains <commit>] [--no-contains <commit>]\n"
        "                [--points-at <object>] [--sort=<key>] [--format=<format>]\n"
        "                [--merged <commit>] [--no-merged <commit>] [<pattern>...]",
    ),
    "version": ("git version",),
}

# parse-options' layout for an option row: the description starts at
# column 26, two past the 24 its spellings may fill; spellings reaching
# column 26 or further put the description on a line of its own.
GIT_USAGE_WIDTH = 24
GIT_USAGE_GAP = 2
