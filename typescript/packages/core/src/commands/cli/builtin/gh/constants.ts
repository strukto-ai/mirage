// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

// Values from gh 2.85.0 (MIT; see licenses/third_party/gh.txt).

import type { RepoEditField } from './types.ts'

const ISSUE_PR_FLAGS = [
  'app',
  'archived',
  'assignee',
  'author',
  'closed',
  'commenter',
  'comments',
  'created',
  'interactions',
  'involves',
  'label',
  'language',
  'locked',
  'match',
  'mentions',
  'milestone',
  'no-assignee',
  'no-label',
  'no-milestone',
  'no-project',
  'owner',
  'project',
  'reactions',
  'repo',
  'state',
  'team-mentions',
  'updated',
  'visibility',
]
export const SEARCH_FLAGS: Record<string, string[]> = {
  issues: [...ISSUE_PR_FLAGS, 'include-prs'],
  prs: [
    ...ISSUE_PR_FLAGS,
    'base',
    'checks',
    'draft',
    'head',
    'merged',
    'merged-at',
    'review',
    'review-requested',
    'reviewed-by',
  ],
  repos: [
    'archived',
    'created',
    'followers',
    'forks',
    'good-first-issues',
    'help-wanted-issues',
    'include-forks',
    'language',
    'license',
    'match',
    'number-topics',
    'owner',
    'size',
    'stars',
    'topic',
    'updated',
    'visibility',
  ],
  code: ['extension', 'filename', 'language', 'match', 'owner', 'repo', 'size'],
  commits: [
    'author',
    'author-date',
    'author-email',
    'author-name',
    'committer',
    'committer-date',
    'committer-email',
    'committer-name',
    'hash',
    'merge',
    'owner',
    'parent',
    'repo',
    'tree',
    'visibility',
  ],
}
export const SEARCH_MULTIPLE: string[] = [
  'label',
  'match',
  'owner',
  'repo',
  'visibility',
  'license',
  'topic',
]
// The values a gh boolean flag takes after `=`.
export const BOOLEAN = ['true', 'false']
export const SEARCH_BOOLEAN: string[] = [
  'archived',
  'draft',
  'merge',
  'locked',
  'merged',
  'include-prs',
  'no-assignee',
  'no-label',
  'no-milestone',
  'no-project',
]
export const SEARCH_SORTS: Record<string, string[]> = {
  issues: [
    'comments',
    'created',
    'interactions',
    'reactions',
    'reactions-+1',
    'reactions--1',
    'reactions-heart',
    'reactions-smile',
    'reactions-tada',
    'reactions-thinking_face',
    'updated',
  ],
  prs: [
    'comments',
    'reactions',
    'reactions-+1',
    'reactions--1',
    'reactions-smile',
    'reactions-thinking_face',
    'reactions-heart',
    'reactions-tada',
    'interactions',
    'created',
    'updated',
  ],
  repos: ['forks', 'help-wanted-issues', 'stars', 'updated'],
  commits: ['author-date', 'committer-date'],
}
export const SEARCH_QUERY_USE: Record<string, string> = { code: '<query>' }
export const SEARCH_USAGE: Record<string, readonly [string, string | null]> = {
  app: ['Filter by GitHub App author', null],
  archived: ['Filter based on the repository archived state {true|false}', null],
  assignee: ['Filter by assignee', null],
  author: ['Filter by author', null],
  closed: ['Filter on closed at date', 'date'],
  commenter: ['Filter based on comments by user', 'user'],
  comments: ['Filter on number of comments', 'number'],
  created: ['Filter based on created at date', 'date'],
  interactions: ['Filter on number of reactions and comments', 'number'],
  involves: ['Filter based on involvement of user', 'user'],
  label: ['Filter on label', null],
  language: ['Filter based on the coding language', null],
  locked: ['Filter on locked conversation status', null],
  match: ['Restrict search to specific field of issue: {title|body|comments}', null],
  mentions: ['Filter based on user mentions', 'user'],
  milestone: ['Filter by milestone title', 'title'],
  'no-assignee': ['Filter on missing assignee', null],
  'no-label': ['Filter on missing label', null],
  'no-milestone': ['Filter on missing milestone', null],
  'no-project': ['Filter on missing project', null],
  owner: ['Filter on repository owner', null],
  project: ['Filter on project board owner/number', 'owner/number'],
  reactions: ['Filter on number of reactions', 'number'],
  repo: ['Filter on repository', 'strings'],
  state: ['Filter based on state', null],
  'team-mentions': ['Filter based on team mentions', null],
  updated: ['Filter on last updated at date', 'date'],
  visibility: ['Filter based on repository visibility: {public|private|internal}', null],
  'include-prs': ['Include pull requests in results', null],
  json: ['Output JSON with the specified fields', 'fields'],
  jq: ['Filter JSON output using a jq expression', 'expression'],
  template: ['Format JSON output using a Go template; see "gh help formatting"', null],
  limit: ['Maximum number of results to fetch', null],
  sort: [
    'Sort fetched results: {comments|created|interactions|reactions|reactions-+1|reactions--1|reactions-heart|reactions-smile|reactions-tada|reactions-thinking_face|updated} (default "best-match")',
    null,
  ],
  order: [
    'Order of results returned, ignored unless \'--sort\' flag is specified: {asc|desc} (default "desc")',
    null,
  ],
  base: ['Filter on base branch name', null],
  checks: ['Filter based on status of the checks', null],
  draft: ['Filter based on draft state', null],
  head: ['Filter on head branch name', null],
  merged: ['Filter based on merged state', null],
  'merged-at': ['Filter on merged at date', 'date'],
  review: ['Filter based on review status', null],
  'review-requested': ['Filter on user or team requested to review', 'user'],
  'reviewed-by': ['Filter on user who reviewed', 'user'],
  followers: ['Filter based on number of followers', 'number'],
  forks: ['Filter on number of forks', 'number'],
  'good-first-issues': ["Filter on number of issues with the 'good first issue' label", 'number'],
  'help-wanted-issues': ["Filter on number of issues with the 'help wanted' label", 'number'],
  'include-forks': ['Include forks in fetched repositories', null],
  license: ['Filter based on license type', null],
  'number-topics': ['Filter on number of topics', 'number'],
  size: ['Filter on a size range, in kilobytes', null],
  stars: ['Filter on number of stars', 'number'],
  topic: ['Filter on topic', null],
  extension: ['Filter on file extension', null],
  filename: ['Filter on filename', null],
  'author-date': ['Filter based on authored date', 'date'],
  'author-email': ['Filter on author email', null],
  'author-name': ['Filter on author name', null],
  committer: ['Filter by committer', null],
  'committer-date': ['Filter based on committed date', 'date'],
  'committer-email': ['Filter on committer email', null],
  'committer-name': ['Filter on committer name', null],
  hash: ['Filter by commit hash', null],
  merge: ['Filter on merge commits', null],
  parent: ['Filter by parent hash', null],
  tree: ['Filter by tree hash', null],
}
export const SEARCH_KIND_USAGE: Record<string, Record<string, readonly [string, string | null]>> = {
  prs: {
    sort: [
      'Sort fetched results: {comments|reactions|reactions-+1|reactions--1|reactions-smile|reactions-thinking_face|reactions-heart|reactions-tada|interactions|created|updated} (default "best-match")',
      null,
    ],
  },
  repos: {
    match: ['Restrict search to specific field of repository: {name|description|readme}', null],
    owner: ['Filter on owner', null],
    visibility: ['Filter based on visibility: {public|private|internal}', null],
    limit: ['Maximum number of repositories to fetch', null],
    sort: [
      'Sort fetched repositories: {forks|help-wanted-issues|stars|updated} (default "best-match")',
      null,
    ],
    order: [
      'Order of repositories returned, ignored unless \'--sort\' flag is specified: {asc|desc} (default "desc")',
      null,
    ],
  },
  code: {
    language: ['Filter results by language', null],
    match: ['Restrict search to file contents or file path: {file|path}', null],
    owner: ['Filter on owner', null],
    size: ['Filter on size range, in kilobytes', null],
    limit: ['Maximum number of code results to fetch', null],
  },
  commits: {
    limit: ['Maximum number of commits to fetch', null],
    sort: ['Sort fetched commits: {author-date|committer-date} (default "best-match")', null],
    order: [
      'Order of commits returned, ignored unless \'--sort\' flag is specified: {asc|desc} (default "desc")',
      null,
    ],
  },
}
export const REPO_EDIT_FIELDS: readonly RepoEditField[] = [
  {
    flag: '--description',
    field: 'description',
    kind: 'value',
    description: 'Description of the repository',
    short: '-d',
  },
  {
    flag: '--homepage',
    field: 'homepage',
    kind: 'value',
    description: 'Repository home page URL',
    short: '-h',
    metavar: 'URL',
  },
  {
    flag: '--default-branch',
    field: 'default_branch',
    kind: 'value',
    description: 'Set the default branch name for the repository',
    metavar: 'name',
  },
  {
    flag: '--visibility',
    field: 'visibility',
    kind: 'value',
    description: 'Change the visibility of the repository to {public,private,internal}',
    choices: ['public', 'private', 'internal'],
  },
  {
    flag: '--template',
    field: 'is_template',
    kind: 'toggle',
    description: 'Make the repository available as a template repository',
  },
  {
    flag: '--enable-issues',
    field: 'has_issues',
    kind: 'toggle',
    description: 'Enable issues in the repository',
  },
  {
    flag: '--enable-projects',
    field: 'has_projects',
    kind: 'toggle',
    description: 'Enable projects in the repository',
  },
  {
    flag: '--enable-wiki',
    field: 'has_wiki',
    kind: 'toggle',
    description: 'Enable wiki in the repository',
  },
  {
    flag: '--enable-discussions',
    field: 'has_discussions',
    kind: 'toggle',
    description: 'Enable discussions in the repository',
  },
  {
    flag: '--enable-merge-commit',
    field: 'allow_merge_commit',
    kind: 'toggle',
    description: 'Enable merging pull requests via merge commit',
  },
  {
    flag: '--enable-squash-merge',
    field: 'allow_squash_merge',
    kind: 'toggle',
    description: 'Enable merging pull requests via squashed commit',
  },
  {
    flag: '--enable-rebase-merge',
    field: 'allow_rebase_merge',
    kind: 'toggle',
    description: 'Enable merging pull requests via rebase',
  },
  {
    flag: '--enable-auto-merge',
    field: 'allow_auto_merge',
    kind: 'toggle',
    description: 'Enable auto-merge functionality',
  },
  {
    flag: '--enable-advanced-security',
    field: 'advanced_security',
    kind: 'security',
    description: 'Enable advanced security in the repository',
  },
  {
    flag: '--enable-secret-scanning',
    field: 'secret_scanning',
    kind: 'security',
    description: 'Enable secret scanning in the repository',
  },
  {
    flag: '--enable-secret-scanning-push-protection',
    field: 'secret_scanning_push_protection',
    kind: 'security',
    description:
      'Enable secret scanning push protection in the repository. Secret scanning must be enabled first',
  },
  {
    flag: '--delete-branch-on-merge',
    field: 'delete_branch_on_merge',
    kind: 'toggle',
    description: 'Delete head branch when pull requests are merged',
  },
  {
    flag: '--allow-forking',
    field: 'allow_forking',
    kind: 'toggle',
    description: 'Allow forking of an organization repository',
  },
  {
    flag: '--allow-update-branch',
    field: 'allow_update_branch',
    kind: 'toggle',
    description: 'Allow a pull request head branch that is behind its base branch to be updated',
  },
]

// The help topics `gh help` answers, in this gh's own terms. gh's other topics
// (formatting, mintty, reference, telemetry) describe a terminal, a config
// directory or a manual a workspace does not have, so they are unknown here.
export const HELP_TOPICS: Record<string, string> = {
  environment:
    'This gh reads no environment variables: `GH_TOKEN`, `GITHUB_TOKEN`, `GH_HOST`, `GH_REPO`\n' +
    "and the rest of gh's list have no effect here.\n\n" +
    'The token, the API base URL, the default repository and the current branch come from the\n' +
    "workspace's gh configuration: `token`, `base_url`, `repo` and `branch`.\n",
  'exit-codes':
    'gh follows normal conventions regarding exit codes.\n\n' +
    '- If a command completes successfully, the exit code will be 0\n\n' +
    '- If a command fails for any reason, the exit code will be 1\n\n' +
    '- If the command line is refused before the command runs, such as for an unknown flag,\n' +
    '  the exit code will be 2\n',
}

export const GIST_ORIGIN = 'https://gist.github.com'
export const GITHUB_HOST = 'github.com'
// How gh 2.46 refuses a list verb's --limit under 1, before any request:
// `invalid limit: 0`, and `invalid value for --limit: 0` from pr list.
export const CONNECT_HINT = 'check your internet connection or https://githubstatus.com'
