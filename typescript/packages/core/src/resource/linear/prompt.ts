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

export const LINEAR_PROMPT = `{prefix}
  teams/
    <team-key>__<team-name>__<team-id>/
      team.json
      members/
        <display-name>__<user-id>.json
      issues/
        <issue-key>__<issue-id>/
          issue.json
          comments.jsonl
      projects/
        <name>__<project-id>.json
      cycles/
        <name>__<cycle-id>.json
      documents/
        <title>__<document-id>.json
  Always ls directories first to discover exact names.

  Folder/file name anatomy: every entity-named segment is
    <sanitized-human-readable>__<id>
  The human-readable part is sanitized — don't construct it; ls the
  parent dir to discover exact entry names.
  IDs are the LAST "__"-separated segment. To extract:
    {prefix}/teams/STR__Strukto-ai__<team-id>/             -> <team-id>
    {prefix}/teams/.../issues/STR-42__<issue-id>/          -> <issue-id>
    {prefix}/teams/.../members/Alice__<user-id>.json       -> <user-id>

  All cat output is mirage-normalized (snake_case keys), NOT the raw
  Linear GraphQL response. Shapes:

  team.json:
    {
      "team_id": "...", "team_key": "STR", "team_name": "Strukto",
      "name": "...", "description": "...", "timezone": "...",
      "updated_at": "...",
      "states": [
        { "state_id": "...", "state_name": "Todo", "type": "unstarted" },
        ...                              # one element per workflow state
      ]
    }

  issue.json:
    {
      "issue_id": "...", "issue_key": "STR-42",
      "title": "...", "description": "...",
      "team_id": "...", "team_key": "...", "team_name": "...",
      "project_id": "...",   "project_name": "...",
      "cycle_id": "...",     "cycle_name": "...",   "cycle_number": 7,
      "state_id": "...",     "state_name": "In Progress",
      "assignee_id": "...",  "assignee_email": "...", "assignee_name": "...",
      "creator_id":  "...",  "creator_email":  "...", "creator_name":  "...",
      "priority": 2,         # 0=none 1=urgent 2=high 3=medium 4=low
      "label_ids":   ["..."],
      "label_names": ["bug", "frontend"],
      "created_at": "...", "updated_at": "...", "url": "..."
    }

  comments.jsonl:                      # one normalized comment per line
    { "comment_id": "...", "issue_id": "...", "issue_key": "STR-42",
      "user_id": "...", "user_email": "...", "user_name": "...",
      "body": "...", "created_at": "...", "updated_at": "...",
      "url": "..." }

  project.json:
    {
      "project_id": "...", "team_id": "...",
      "name": "...", "description": "...", "state": "started",
      "lead_id": "...", "updated_at": "...", "url": "...",
      "issue_count": 12,
      "issues": [
        { "issue_id": "...", "issue_key": "STR-42", "title": "...",
          "state_id": "...", "state_name": "In Progress", "url": "..." }
      ]
    }

  cycle.json:
    {
      "cycle_id": "...", "team_id": "...",
      "name": "...", "number": 7,
      "starts_at": "...", "ends_at": "...",
      "updated_at": "...", "url": "..."
    }

  user.json:
    {
      "user_id": "...", "name": "...", "display_name": "...",
      "email": "...", "is_active": true, "is_admin": false,
      "updated_at": "...", "url": "..."
    }

  Useful jq paths:
    .issue_key                              # issue.json
    .state_name                             # issue.json
    .assignee_email                         # issue.json
    .label_names[]                          # issue.json
    .issues[] | select(.state_name == "In Progress")   # project.json
    .states[].state_name                    # team.json
    [inputs] | length                       # comments.jsonl: count
    [inputs | select(.user_email == "x")] | length     # comments.jsonl

  document.json:
    {
      "document_id": "...", "title": "...", "content": "...",
      "project_id": "...", "project_name": "...",
      "creator_id": "...", "creator_name": "...", "creator_email": "...",
      "created_at": "...", "updated_at": "...", "url": "..."
    }

  Read commands (nested names, mirror the linear CLI; every command emits
  normalized JSON to stdout so you can pipe to jq):
    linear team list                        # all teams
    linear team get <team-key>              # one team
    linear team members <team-key>          # team roster
    linear issue list --team <team-key>     # issues in a team
    linear issue get <issue-key>            # one issue (e.g. STR-42)
    linear project list --team <team-key>
    linear project get <project-id> --team <team-key>
    linear cycle list --team <team-key>
    linear cycle current --team <team-key>  # latest cycle
    linear cycle get <cycle-id> --team <team-key>
    linear label list --team <team-key>
    linear comment list <issue-key>
    linear user list                        # all workspace users
    linear user get <email>
    linear document list --team <team-key>
    linear document get <document-id> --team <team-key>
    linear search "bug login"               # full-text across all issues`

export const LINEAR_WRITE_PROMPT = `  Write commands (nested names; flags use UNDERSCORES, not hyphens; --issue_id
  and --issue_key are interchangeable on every issue command):

    linear issue create --team_id <team-id> \\
      --title "Title" --description "Body"
      # or: --description_file /path/to/desc.md

    linear issue update --issue_key STR-42 \\
      [--title "New title"] [--description "..." | --description_file ...]

    linear issue assign --issue_key STR-42 --assignee_email user@example.com
      # or: --assignee_id <user-id>

    linear issue transition --issue_key STR-42 --state_name "In Review"
      # or: --state_id <state-id>

    linear issue set-priority --issue_key STR-42 --priority 2
      # 0=none 1=urgent 2=high 3=medium 4=low

    linear issue set-project --issue_key STR-42 --project_id <project-id>

    linear issue add-label --issue_key STR-42 --label_id <label-id>

    linear comment add --issue_key STR-42 --body "comment"
      # or: --body_file /path/to/comment.md

    linear comment update --comment_id <comment-id> --body "..."

  IDs come from the path:
    {prefix}/teams/STR__Strukto-ai__<team-id>/                  -> --team_id
    {prefix}/teams/.../issues/STR-42__<issue-id>/               -> --issue_id
    {prefix}/teams/.../projects/Roadmap__<project-id>.json      -> --project_id

  Successful create returns JSON like:
    {"issue_id": "<uuid>", "issue_key": "STR-23", "title": "...", ...}
  Empty stdout means the call failed -- inspect stderr or retry.`
