// The repository lookups of gh 2.85.0's api/queries_repo.go and
// api/queries_org.go (MIT; see licenses/third_party/gh.txt).

use super::client::{Account, Failure, Result, value};
use super::json::{Json, Obj};
use super::repo::{RepoRef, current_login, graphql_data};

const ACTORS: &str = "query RepositoryAssignableActors($endCursor:String$name:String!$owner:String!){repository(owner: $owner, name: $name){suggestedActors(first: 100, after: $endCursor, capabilities: CAN_BE_ASSIGNED){nodes{... on User{id,login,name,__typename},... on Bot{id,login,__typename}},pageInfo{hasNextPage,endCursor}}}}";
const USERS: &str = "query RepositoryAssignableUsers($endCursor:String$name:String!$owner:String!){repository(owner: $owner, name: $name){assignableUsers(first: 100, after: $endCursor){nodes{id,login,name},pageInfo{hasNextPage,endCursor}}}}";
const LABELS: &str = "query RepositoryLabelList($endCursor:String$name:String!$owner:String!){repository(owner: $owner, name: $name){labels(first: 100, orderBy: {field: NAME, direction: ASC}, after: $endCursor){nodes{id,name},pageInfo{hasNextPage,endCursor}}}}";
const MILESTONES: &str = "query RepositoryMilestoneList($endCursor:String$name:String!$owner:String!$states:[MilestoneState!]){repository(owner: $owner, name: $name){milestones(states: $states, first: 100, after: $endCursor){nodes{id,title},pageInfo{hasNextPage,endCursor}}}}";
const TEAMS: &str = "query OrganizationTeamList($endCursor:String$owner:String!){organization(login: $owner){teams(first: 100, orderBy: {field: NAME, direction: ASC}, after: $endCursor){nodes{id,slug},pageInfo{hasNextPage,endCursor}}}}";
const NOT_AN_ORGANIZATION: &str = "Could not resolve to an Organization";

/// Which of a repository's lists a line needs to name what it sets.
#[derive(Default)]
pub(crate) struct Wanted {
    /// Assignees come from the repository's actors, which hold bots too,
    /// rather than its users: every write but `gh pr create`.
    pub(crate) actor_assignees: bool,
    pub(crate) assignees: bool,
    pub(crate) reviewers: bool,
    pub(crate) team_reviewers: bool,
    pub(crate) labels: bool,
    pub(crate) milestones: bool,
}

/// A repository's assignable people, labels and milestones.
#[derive(Default)]
pub(crate) struct Metadata {
    actors: Vec<Json>,
    teams: Vec<Json>,
    labels: Vec<Json>,
    milestones: Vec<Json>,
}

async fn paged(
    account: &Account,
    query: &str,
    root: &str,
    field: &str,
    variables: &Obj,
) -> Result<Vec<Json>> {
    let mut rows = Vec::new();
    let mut cursor = Json::Null;
    loop {
        let mut asked = variables.clone();
        asked.set("endCursor", cursor);
        let data = graphql_data(account, query, asked).await?;
        let page = data.get(root).get(field);
        rows.extend(page.get("nodes").items().iter().cloned());
        let info = page.get("pageInfo");
        if !info.get("hasNextPage").truthy() {
            return Ok(rows);
        }
        cursor = info.get("endCursor").clone();
    }
}

fn fetching(what: &'static str) -> impl Fn(Failure) -> Failure {
    move |failure| Failure::Value(format!("error fetching {what}: {}", failure.text()))
}

/// The lists `wanted` names, each failure in RepoMetadata's words.
pub(crate) async fn repo_metadata(
    account: &Account,
    target: &RepoRef,
    wanted: &Wanted,
) -> Result<Metadata> {
    let mut found = Metadata::default();
    let mut named = Obj::new();
    named.set("name", target.repo.as_str());
    named.set("owner", target.owner.as_str());
    let repository = "repository";
    if wanted.assignees || wanted.reviewers {
        found.actors = if wanted.actor_assignees {
            paged(account, ACTORS, repository, "suggestedActors", &named)
                .await
                .map_err(fetching("assignable actors"))?
        } else {
            paged(account, USERS, repository, "assignableUsers", &named)
                .await
                .map_err(fetching("assignable users"))?
        };
    }
    if wanted.reviewers && wanted.team_reviewers {
        let mut owner = Obj::new();
        owner.set("owner", target.owner.as_str());
        found.teams = match paged(account, TEAMS, "organization", "teams", &owner).await {
            Ok(teams) => teams,
            Err(failure) if failure.text().contains(NOT_AN_ORGANIZATION) => Vec::new(),
            Err(failure) => return Err(fetching("organization teams")(failure)),
        };
    }
    if wanted.reviewers {
        current_login(account)
            .await
            .map_err(fetching("current login"))?;
    }
    if wanted.labels {
        found.labels = paged(account, LABELS, repository, "labels", &named)
            .await
            .map_err(fetching("labels"))?;
    }
    if wanted.milestones {
        let mut open = named.clone();
        open.set("states", Json::Arr(vec![Json::from("OPEN")]));
        found.milestones = paged(account, MILESTONES, repository, "milestones", &open)
            .await
            .map_err(fetching("milestones"))?;
    }
    Ok(found)
}

fn same(left: &str, right: &str) -> bool {
    left.to_lowercase() == right.to_lowercase()
}

/// An actor as gh's prompts spell it, which a line may also name it by.
fn display_name(actor: &Json) -> String {
    let login = actor.get("login").text();
    match actor.get("name").as_str().filter(|name| !name.is_empty()) {
        Some(name) => format!("{login} ({name})"),
        None => login.to_owned(),
    }
}

fn id_of(rows: &[Json], key: &str, name: &str) -> Result<String> {
    match rows.iter().find(|row| same(row.get(key).text(), name)) {
        Some(row) => Ok(row.get("id").text().to_owned()),
        None => value(format!("'{name}' not found")),
    }
}

impl Metadata {
    pub(crate) fn members_to_ids(&self, names: &[String]) -> Result<Vec<String>> {
        names
            .iter()
            .map(|name| {
                let found = self.actors.iter().find(|actor| {
                    same(actor.get("login").text(), name) || same(&display_name(actor), name)
                });
                match found {
                    Some(actor) => Ok(actor.get("id").text().to_owned()),
                    None => value(format!("'{name}' not found")),
                }
            })
            .collect()
    }

    pub(crate) fn teams_to_ids(&self, names: &[String]) -> Result<Vec<String>> {
        names
            .iter()
            .map(|name| {
                let slug = name.rsplit('/').next().unwrap_or(name);
                match self
                    .teams
                    .iter()
                    .find(|team| same(team.get("slug").text(), slug))
                {
                    Some(team) => Ok(team.get("id").text().to_owned()),
                    None => value(format!("'{name}' not found")),
                }
            })
            .collect()
    }

    pub(crate) fn labels_to_ids(&self, names: &[String]) -> Result<Vec<String>> {
        names
            .iter()
            .map(|name| id_of(&self.labels, "name", name))
            .collect()
    }

    pub(crate) fn milestone_to_id(&self, title: &str) -> Result<String> {
        id_of(&self.milestones, "title", title)
    }
}
