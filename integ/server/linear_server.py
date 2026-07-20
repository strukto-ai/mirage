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

import argparse
import asyncio
import json
import re
from pathlib import Path
from typing import Any

from aiohttp import web

FIXTURE = Path(
    __file__).resolve().parents[1] / "fixtures" / "linear" / "v1.json"
WRITE_STAMP = "2026-06-19T00:00:00.000Z"
OP_RE = re.compile(r"(?:query|mutation)\s+(\w+)")
EMPTY_PAGE = {"hasNextPage": False, "endCursor": None}


class FakeLinear:

    def __init__(self) -> None:
        self.base = ""
        self.team_order: list[str] = []
        self.teams_by_id: dict[str, dict[str, Any]] = {}
        self.team_by_key: dict[str, str] = {}
        self.team_members: dict[str, list[str]] = {}
        self.team_issues: dict[str, list[str]] = {}
        self.team_projects: dict[str, list[str]] = {}
        self.team_cycles: dict[str, list[str]] = {}
        self.team_issue_max: dict[str, int] = {}
        self.users_by_id: dict[str, dict[str, Any]] = {}
        self.labels_by_id: dict[str, dict[str, Any]] = {}
        self.states_by_id: dict[str, dict[str, Any]] = {}
        self.projects_by_id: dict[str, dict[str, Any]] = {}
        self.cycles_by_id: dict[str, dict[str, Any]] = {}
        self.issues_by_id: dict[str, dict[str, Any]] = {}
        self.issue_comments: dict[str, list[dict[str, Any]]] = {}
        self.comment_issue: dict[str, str] = {}
        self.team_labels: dict[str, list[str]] = {}
        self.team_documents: dict[str, list[str]] = {}
        self.documents_by_id: dict[str, dict[str, Any]] = {}
        self._counter = 0

    def next_id(self, kind: str) -> str:
        self._counter += 1
        return f"{kind}_new_{self._counter}"

    def seed(self, data: dict[str, Any]) -> None:
        self.team_order = []
        self.teams_by_id = {}
        self.team_by_key = {}
        self.team_members = {}
        self.team_issues = {}
        self.team_projects = {}
        self.team_cycles = {}
        self.team_issue_max = {}
        self.users_by_id = {}
        self.labels_by_id = {}
        self.states_by_id = {}
        self.projects_by_id = {}
        self.cycles_by_id = {}
        self.issues_by_id = {}
        self.issue_comments = {}
        self.comment_issue = {}
        self.team_labels = {}
        self.team_documents = {}
        self.documents_by_id = {}
        self._counter = 0
        for team in data.get("teams", []):
            self._seed_team(team)

    def _seed_team(self, team: dict[str, Any]) -> None:
        team_id = team["id"]
        self.team_order.append(team_id)
        self.team_by_key[team["key"]] = team_id
        self.teams_by_id[team_id] = {
            "id": team_id,
            "key": team["key"],
            "name": team.get("name"),
            "description": team.get("description"),
            "timezone": team.get("timezone"),
            "updatedAt": team.get("updatedAt"),
            "states": list(team.get("states", [])),
        }
        for state in team.get("states", []):
            self.states_by_id[state["id"]] = state
        self.team_labels[team_id] = []
        for label in team.get("labels", []):
            self.labels_by_id[label["id"]] = label
            self.team_labels[team_id].append(label["id"])
        self.team_documents[team_id] = []
        for document in team.get("documents", []):
            self.documents_by_id[document["id"]] = document
            self.team_documents[team_id].append(document["id"])
        self.team_members[team_id] = []
        for user in team.get("members", []):
            self.users_by_id[user["id"]] = user
            self.team_members[team_id].append(user["id"])
        self.team_projects[team_id] = []
        for project in team.get("projects", []):
            self.projects_by_id[project["id"]] = project
            self.team_projects[team_id].append(project["id"])
        self.team_cycles[team_id] = []
        for cycle in team.get("cycles", []):
            self.cycles_by_id[cycle["id"]] = cycle
            self.team_cycles[team_id].append(cycle["id"])
        self.team_issues[team_id] = []
        self.team_issue_max[team_id] = 0
        for issue in team.get("issues", []):
            self._seed_issue(team_id, team["key"], issue)

    def _seed_issue(self, team_id: str, team_key: str,
                    issue: dict[str, Any]) -> None:
        issue_id = issue["id"]
        number = _identifier_number(issue.get("identifier"))
        self.team_issue_max[team_id] = max(self.team_issue_max[team_id],
                                           number)
        self.team_issues[team_id].append(issue_id)
        self.issues_by_id[issue_id] = {
            "id": issue_id,
            "identifier": issue.get("identifier"),
            "number": number,
            "title": issue.get("title"),
            "description": issue.get("description", ""),
            "priority": issue.get("priority"),
            "url": issue.get("url"),
            "createdAt": issue.get("createdAt"),
            "updatedAt": issue.get("updatedAt"),
            "teamId": team_id,
            "stateId": issue.get("stateId"),
            "projectId": issue.get("projectId"),
            "cycleId": issue.get("cycleId"),
            "assigneeId": issue.get("assigneeId"),
            "creatorId": issue.get("creatorId"),
            "labelIds": list(issue.get("labelIds", [])),
        }
        self.issue_comments[issue_id] = []
        for comment in issue.get("comments", []):
            record = {
                "id": comment["id"],
                "body": comment.get("body", ""),
                "url": comment.get("url"),
                "createdAt": comment.get("createdAt"),
                "updatedAt": comment.get("updatedAt"),
                "userId": comment.get("userId"),
            }
            self.issue_comments[issue_id].append(record)
            self.comment_issue[comment["id"]] = issue_id

    def team_node(self, team_id: str) -> dict[str, Any]:
        team = self.teams_by_id[team_id]
        states = [{
            "id": state["id"],
            "name": state.get("name"),
            "type": state.get("type"),
        } for state in team["states"]]
        return {
            "id": team["id"],
            "key": team["key"],
            "name": team["name"],
            "description": team["description"],
            "timezone": team["timezone"],
            "updatedAt": team["updatedAt"],
            "states": {
                "nodes": states
            },
        }

    def user_node(self, user_id: str) -> dict[str, Any]:
        user = self.users_by_id[user_id]
        return {
            "id": user["id"],
            "name": user.get("name"),
            "displayName": user.get("displayName"),
            "email": user.get("email"),
            "active": user.get("active"),
            "admin": user.get("admin"),
            "url": user.get("url"),
            "updatedAt": user.get("updatedAt"),
        }

    def issue_node(self, issue_id: str) -> dict[str, Any]:
        issue = self.issues_by_id[issue_id]
        return {
            "id": issue["id"],
            "identifier": issue["identifier"],
            "title": issue["title"],
            "description": issue["description"],
            "priority": issue["priority"],
            "url": issue["url"],
            "createdAt": issue["createdAt"],
            "updatedAt": issue["updatedAt"],
            "team": self._team_ref(issue["teamId"]),
            "state": self._state_ref(issue["stateId"]),
            "project": self._project_ref(issue["projectId"]),
            "cycle": self._cycle_ref(issue["cycleId"]),
            "assignee": self._person_ref(issue["assigneeId"]),
            "creator": self._person_ref(issue["creatorId"]),
            "labels": {
                "nodes": self._label_refs(issue["labelIds"])
            },
        }

    def project_node(self, project_id: str) -> dict[str, Any]:
        project = self.projects_by_id[project_id]
        lead_id = project.get("leadId")
        return {
            "id": project["id"],
            "name": project.get("name"),
            "description": project.get("description"),
            "status": {
                "type": project.get("statusType")
            },
            "url": project.get("url"),
            "updatedAt": project.get("updatedAt"),
            "lead": {
                "id": lead_id
            } if lead_id else None,
        }

    def cycle_node(self, cycle_id: str) -> dict[str, Any]:
        cycle = self.cycles_by_id[cycle_id]
        return {
            "id": cycle["id"],
            "name": cycle.get("name"),
            "number": cycle.get("number"),
            "startsAt": cycle.get("startsAt"),
            "endsAt": cycle.get("endsAt"),
            "updatedAt": cycle.get("updatedAt"),
        }

    def label_node(self, label_id: str) -> dict[str, Any]:
        label = self.labels_by_id[label_id]
        return {
            "id": label["id"],
            "name": label.get("name"),
            "color": label.get("color"),
        }

    def document_node(self, document_id: str) -> dict[str, Any]:
        document = self.documents_by_id[document_id]
        return {
            "id": document["id"],
            "title": document.get("title"),
            "content": document.get("content", ""),
            "url": document.get("url"),
            "createdAt": document.get("createdAt"),
            "updatedAt": document.get("updatedAt"),
            "project": self._project_ref(document.get("projectId")),
            "creator": self._person_ref(document.get("creatorId")),
        }

    def comment_node(self, comment: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": comment["id"],
            "body": comment.get("body", ""),
            "url": comment.get("url"),
            "createdAt": comment.get("createdAt"),
            "updatedAt": comment.get("updatedAt"),
            "user": self._user_ref(comment.get("userId")),
        }

    def search_node(self, issue_id: str) -> dict[str, Any]:
        issue = self.issues_by_id[issue_id]
        assignee_id = issue["assigneeId"]
        assignee = None
        if assignee_id and assignee_id in self.users_by_id:
            user = self.users_by_id[assignee_id]
            assignee = {
                "id": user["id"],
                "displayName": user.get("displayName"),
                "email": user.get("email"),
            }
        return {
            "id": issue["id"],
            "identifier": issue["identifier"],
            "title": issue["title"],
            "state": self._state_ref(issue["stateId"]),
            "assignee": assignee,
            "url": issue["url"],
        }

    def _team_ref(self, team_id: str | None) -> dict[str, Any] | None:
        if not team_id or team_id not in self.teams_by_id:
            return None
        team = self.teams_by_id[team_id]
        return {"id": team["id"], "key": team["key"], "name": team["name"]}

    def _state_ref(self, state_id: str | None) -> dict[str, Any] | None:
        if not state_id or state_id not in self.states_by_id:
            return None
        state = self.states_by_id[state_id]
        return {"id": state["id"], "name": state.get("name")}

    def _project_ref(self, project_id: str | None) -> dict[str, Any] | None:
        if not project_id or project_id not in self.projects_by_id:
            return None
        project = self.projects_by_id[project_id]
        return {"id": project["id"], "name": project.get("name")}

    def _cycle_ref(self, cycle_id: str | None) -> dict[str, Any] | None:
        if not cycle_id or cycle_id not in self.cycles_by_id:
            return None
        cycle = self.cycles_by_id[cycle_id]
        return {
            "id": cycle["id"],
            "name": cycle.get("name"),
            "number": cycle.get("number"),
        }

    def _person_ref(self, user_id: str | None) -> dict[str, Any] | None:
        if not user_id or user_id not in self.users_by_id:
            return None
        user = self.users_by_id[user_id]
        return {
            "id": user["id"],
            "name": user.get("name"),
            "email": user.get("email"),
        }

    def _user_ref(self, user_id: str | None) -> dict[str, Any] | None:
        if not user_id or user_id not in self.users_by_id:
            return None
        user = self.users_by_id[user_id]
        return {
            "id": user["id"],
            "name": user.get("name"),
            "displayName": user.get("displayName"),
            "email": user.get("email"),
        }

    def _label_refs(self, label_ids: list[str]) -> list[dict[str, Any]]:
        refs = []
        for label_id in label_ids:
            label = self.labels_by_id.get(label_id)
            if label is not None:
                refs.append({"id": label["id"], "name": label.get("name")})
        return refs


def _identifier_number(identifier: str | None) -> int:
    if not identifier or "-" not in identifier:
        return 0
    tail = identifier.rsplit("-", 1)[1]
    return int(tail) if tail.isdigit() else 0


def _connection(nodes: list[dict[str, Any]]) -> dict[str, Any]:
    return {"nodes": nodes, "pageInfo": dict(EMPTY_PAGE)}


class LinearServer:

    def __init__(self, state: FakeLinear) -> None:
        self.state = state

    async def reset(self, request: web.Request) -> web.Response:
        self.state.seed(json.loads(FIXTURE.read_text()))
        return web.json_response({"ok": True})

    async def graphql(self, request: web.Request) -> web.Response:
        body = await request.json()
        query = body.get("query") or ""
        variables = body.get("variables") or {}
        match = OP_RE.search(query)
        if match is None:
            return _errors("could not parse operation")
        op = match.group(1)
        handler = getattr(self, f"op_{op.lower()}", None)
        if handler is None:
            return _errors(f"unknown operation: {op}")
        return handler(variables)

    def op_teams(self, variables: dict[str, Any]) -> web.Response:
        nodes = [self.state.team_node(tid) for tid in self.state.team_order]
        return _data({"teams": _connection(nodes)})

    def op_teammembers(self, variables: dict[str, Any]) -> web.Response:
        team_id = variables.get("teamId")
        ids = self.state.team_members.get(team_id, [])
        nodes = [self.state.user_node(uid) for uid in ids]
        return _data({"team": {"members": _connection(nodes)}})

    def op_teamissues(self, variables: dict[str, Any]) -> web.Response:
        team_id = variables.get("teamId")
        ids = self.state.team_issues.get(team_id, [])
        nodes = [self.state.issue_node(iid) for iid in ids]
        return _data({"team": {"issues": _connection(nodes)}})

    def op_teamprojects(self, variables: dict[str, Any]) -> web.Response:
        team_id = variables.get("teamId")
        ids = self.state.team_projects.get(team_id, [])
        nodes = [self.state.project_node(pid) for pid in ids]
        return _data({"team": {"projects": _connection(nodes)}})

    def op_teamcycles(self, variables: dict[str, Any]) -> web.Response:
        team_id = variables.get("teamId")
        ids = self.state.team_cycles.get(team_id, [])
        nodes = [self.state.cycle_node(cid) for cid in ids]
        return _data({"team": {"cycles": _connection(nodes)}})

    def op_teamlabels(self, variables: dict[str, Any]) -> web.Response:
        team_id = variables.get("teamId")
        ids = self.state.team_labels.get(team_id, [])
        nodes = [self.state.label_node(lid) for lid in ids]
        return _data({"team": {"labels": _connection(nodes)}})

    def op_teamdocuments(self, variables: dict[str, Any]) -> web.Response:
        team_id = variables.get("teamId")
        ids = self.state.team_documents.get(team_id, [])
        nodes = [self.state.document_node(did) for did in ids]
        return _data({"team": {"documents": _connection(nodes)}})

    def op_issue(self, variables: dict[str, Any]) -> web.Response:
        issue_id = variables.get("issueId")
        if issue_id not in self.state.issues_by_id:
            return _data({"issue": None})
        return _data({"issue": self.state.issue_node(issue_id)})

    def op_issuecomments(self, variables: dict[str, Any]) -> web.Response:
        issue_id = variables.get("issueId")
        comments = self.state.issue_comments.get(issue_id, [])
        nodes = [self.state.comment_node(comment) for comment in comments]
        return _data({"issue": {"comments": _connection(nodes)}})

    def op_issuelookup(self, variables: dict[str, Any]) -> web.Response:
        team_key = variables.get("teamKey")
        number = variables.get("number")
        team_id = self.state.team_by_key.get(team_key)
        nodes = []
        if team_id is not None and number is not None:
            for issue_id in self.state.team_issues.get(team_id, []):
                issue = self.state.issues_by_id[issue_id]
                if issue["number"] == int(number):
                    nodes.append({
                        "id": issue["id"],
                        "identifier": issue["identifier"],
                    })
                    break
        return _data({"issues": {"nodes": nodes}})

    def op_userlookup(self, variables: dict[str, Any]) -> web.Response:
        email = variables.get("email")
        nodes = []
        for user in self.state.users_by_id.values():
            if user.get("email") == email:
                nodes.append({
                    "id": user["id"],
                    "email": user.get("email"),
                    "name": user.get("name"),
                })
                break
        return _data({"users": {"nodes": nodes}})

    def op_issuesearch(self, variables: dict[str, Any]) -> web.Response:
        term = (variables.get("term") or "").lower()
        limit = variables.get("first") or 50
        nodes = []
        for issue_id, issue in self.state.issues_by_id.items():
            haystack = " ".join([
                issue.get("title") or "",
                issue.get("description") or "",
                issue.get("identifier") or "",
            ]).lower()
            if term in haystack:
                nodes.append(self.state.search_node(issue_id))
            if len(nodes) >= limit:
                break
        return _data({"searchIssues": {"nodes": nodes}})

    def op_issuecreate(self, variables: dict[str, Any]) -> web.Response:
        payload = variables.get("input") or {}
        team_id = payload.get("teamId")
        if team_id not in self.state.teams_by_id:
            return _errors("team not found")
        issue_id = self.state.next_id("iss")
        team_key = self.state.teams_by_id[team_id]["key"]
        number = self.state.team_issue_max[team_id] + 1
        self.state.team_issue_max[team_id] = number
        identifier = f"{team_key}-{number}"
        self.state.team_issues[team_id].append(issue_id)
        self.state.issues_by_id[issue_id] = {
            "id": issue_id,
            "identifier": identifier,
            "number": number,
            "title": payload.get("title", ""),
            "description": payload.get("description", ""),
            "priority": payload.get("priority"),
            "url": f"https://linear.app/strukto/issue/{identifier}",
            "createdAt": WRITE_STAMP,
            "updatedAt": WRITE_STAMP,
            "teamId": team_id,
            "stateId": payload.get("stateId"),
            "projectId": payload.get("projectId"),
            "cycleId": payload.get("cycleId"),
            "assigneeId": payload.get("assigneeId"),
            "creatorId": payload.get("creatorId"),
            "labelIds": list(payload.get("labelIds", [])),
        }
        self.state.issue_comments[issue_id] = []
        return _data({
            "issueCreate": {
                "success": True,
                "issue": {
                    "id": issue_id,
                    "identifier": identifier
                },
            }
        })

    def op_issueupdate(self, variables: dict[str, Any]) -> web.Response:
        issue_id = variables.get("id")
        issue = self.state.issues_by_id.get(issue_id)
        if issue is None:
            return _errors("issue not found")
        payload = variables.get("input") or {}
        field_map = {
            "title": "title",
            "description": "description",
            "stateId": "stateId",
            "assigneeId": "assigneeId",
            "priority": "priority",
            "projectId": "projectId",
            "labelIds": "labelIds",
        }
        for key, field in field_map.items():
            if key in payload:
                issue[field] = payload[key]
        issue["updatedAt"] = WRITE_STAMP
        return _data({
            "issueUpdate": {
                "success": True,
                "issue": {
                    "id": issue_id,
                    "identifier": issue["identifier"],
                },
            }
        })

    def op_commentcreate(self, variables: dict[str, Any]) -> web.Response:
        payload = variables.get("input") or {}
        issue_id = payload.get("issueId")
        issue = self.state.issues_by_id.get(issue_id)
        if issue is None:
            return _errors("issue not found")
        comment_id = self.state.next_id("cmt")
        identifier = issue["identifier"]
        self.state.issue_comments.setdefault(issue_id, []).append({
            "id":
            comment_id,
            "body":
            payload.get("body", ""),
            "url":
            f"https://linear.app/strukto/issue/{identifier}#{comment_id}",
            "createdAt":
            WRITE_STAMP,
            "updatedAt":
            WRITE_STAMP,
            "userId":
            None,
        })
        self.state.comment_issue[comment_id] = issue_id
        return _data({
            "commentCreate": {
                "success": True,
                "comment": {
                    "id": comment_id,
                    "issue": {
                        "id": issue_id,
                        "identifier": identifier
                    },
                },
            }
        })

    def op_commentupdate(self, variables: dict[str, Any]) -> web.Response:
        comment_id = variables.get("id")
        issue_id = self.state.comment_issue.get(comment_id)
        if issue_id is None:
            return _errors("comment not found")
        payload = variables.get("input") or {}
        for comment in self.state.issue_comments.get(issue_id, []):
            if comment["id"] == comment_id:
                if "body" in payload:
                    comment["body"] = payload["body"]
                comment["updatedAt"] = WRITE_STAMP
                break
        identifier = self.state.issues_by_id[issue_id]["identifier"]
        return _data({
            "commentUpdate": {
                "success": True,
                "comment": {
                    "id": comment_id,
                    "issue": {
                        "id": issue_id,
                        "identifier": identifier
                    },
                },
            }
        })


def _data(payload: dict[str, Any]) -> web.Response:
    return web.json_response({"data": payload})


def _errors(message: str) -> web.Response:
    return web.json_response({"errors": [{"message": message}]}, status=400)


def build_app(server: LinearServer) -> web.Application:
    app = web.Application()
    app.router.add_post("/reset", server.reset)
    app.router.add_post("/graphql", server.graphql)
    return app


async def start_fake_linear(
) -> tuple[FakeLinear, LinearServer, web.AppRunner]:
    state = FakeLinear()
    state.seed(json.loads(FIXTURE.read_text()))
    server = LinearServer(state)
    runner = web.AppRunner(build_app(server))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    state.base = f"http://127.0.0.1:{port}/graphql"
    return state, server, runner


async def _serve(port: int) -> None:
    state = FakeLinear()
    state.seed(json.loads(FIXTURE.read_text()))
    server = LinearServer(state)
    runner = web.AppRunner(build_app(server))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()
    state.base = f"http://127.0.0.1:{port}/graphql"
    print(f"LINEAR_ENDPOINT={state.base}", flush=True)
    await asyncio.Event().wait()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    asyncio.run(_serve(args.port))


if __name__ == "__main__":
    main()
