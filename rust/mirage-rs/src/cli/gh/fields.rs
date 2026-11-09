// The --json selections and exports follow gh 2.85.0, printed as Go
// 1.25.5's encoding/json prints them (MIT and BSD-3-Clause; see
// licenses/third_party/gh.txt and go.txt).

use std::collections::HashSet;

use super::shape::{Shape, exported, list_of, pointer, strukt};
use crate::core::github::client::{Account, Failure, Result, value};
use crate::core::github::issue::{IssueSelections, issue_fields};
use crate::core::github::json::{Json, Obj};
use crate::core::github::pull::pull_request_fields;
use crate::core::github::repo::RepoRef;

/// Where a read connection sits in an answer.
#[derive(Clone, Copy)]
pub(crate) enum At {
    Named(&'static str),
    Contexts,
}

/// A connection's selection given the clause that picks the page.
#[derive(Clone, Copy)]
pub(crate) enum Select {
    Of(fn(&str) -> String),
    References(&'static str),
}

impl Select {
    fn text(self, after: &str) -> String {
        match self {
            Select::Of(of) => of(after),
            Select::References(name) => references_select(name, after),
        }
    }
}

/// A connection `gh pr view` and `gh issue view` read to its end.
#[derive(Clone, Copy)]
pub(crate) struct Pages {
    pub(crate) select: Select,
    pub(crate) at: At,
}

pub(crate) enum Export {
    Plain(&'static str, Shape),
    Nodes(&'static str, Shape),
    References(&'static str),
    Custom(fn(&Obj) -> Json),
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum View {
    Never,
    Apart,
}

/// One `--json` field: the GraphQL selection gh 2.85 puts on the wire
/// for it, and gh's own export of the answer.
pub(crate) struct Field {
    pub(crate) select: String,
    pub(crate) export: Export,
    pub(crate) view: Option<View>,
    pub(crate) pages: Option<Pages>,
}

pub(crate) type FieldTable = Vec<(&'static str, Field)>;

pub(crate) fn names(table: &FieldTable) -> Vec<&'static str> {
    table.iter().map(|(name, _)| *name).collect()
}

fn spec<'a>(table: &'a FieldTable, name: &str) -> &'a Field {
    &table
        .iter()
        .find(|(field, _)| *field == name)
        .expect("a field json_fields checked")
        .1
}

pub(crate) fn nodes_of(value: &Json) -> &[Json] {
    value.get("nodes").items()
}

pub(crate) fn login() -> Shape {
    strukt(vec![("login", Shape::Str)])
}

fn user() -> Shape {
    strukt(vec![
        ("id", Shape::Str),
        ("login", Shape::Str),
        ("name", Shape::Str),
        ("databaseId", Shape::Int),
    ])
}

fn label() -> Shape {
    strukt(vec![
        ("id", Shape::Str),
        ("name", Shape::Str),
        ("description", Shape::Str),
        ("color", Shape::Str),
    ])
}

fn comment() -> Shape {
    strukt(vec![
        ("id", Shape::Str),
        ("author", login()),
        ("authorAssociation", Shape::Str),
        ("body", Shape::Str),
        ("createdAt", Shape::Time),
        ("includesCreatedEdit", Shape::Bool),
        ("isMinimized", Shape::Bool),
        ("minimizedReason", Shape::Str),
        ("reactionGroups", Shape::Reactions),
        ("url", Shape::Str),
        ("viewerDidAuthor", Shape::Bool),
    ])
}

fn reference() -> Shape {
    strukt(vec![
        ("id", Shape::Str),
        ("number", Shape::Int),
        (
            "repository",
            strukt(vec![
                ("id", Shape::Str),
                ("name", Shape::Str),
                (
                    "owner",
                    strukt(vec![("id", Shape::Str), ("login", Shape::Str)]),
                ),
            ]),
        ),
        ("url", Shape::Str),
    ])
}

fn project_card() -> Shape {
    strukt(vec![
        ("project", strukt(vec![("name", Shape::Str)])),
        ("column", strukt(vec![("name", Shape::Str)])),
    ])
}

const AFTER: &str = ", after: $endCursor";

fn comments(after: &str) -> String {
    format!(
        "comments(first: 100{after}) {{nodes {{id,author{{login,...on User{{id,name}}}},authorAssociation,body,createdAt,includesCreatedEdit,isMinimized,minimizedReason,reactionGroups{{content,users{{totalCount}}}},url,viewerDidAuthor}},pageInfo{{hasNextPage,endCursor}},totalCount}}"
    )
}

fn project_items_alone(after: &str) -> String {
    format!(
        "projectItems(first: 100{after}){{totalCount,nodes{{id,project{{id,title}},status:fieldValueByName(name: \"Status\"){{... on ProjectV2ItemFieldSingleSelectValue{{optionId,name}}}}}},pageInfo{{hasNextPage,endCursor}}}}"
    )
}

const PROJECT_ITEMS: &str = "projectItems(first:100){nodes{id, project{id,title}, status:fieldValueByName(name: \"Status\") { ... on ProjectV2ItemFieldSingleSelectValue{optionId,name}}},totalCount}";

const PROJECTS_V2_IGNORABLE: [&str; 6] = [
    "field requires one of the following scopes: ['read:project']",
    "Field 'projectsV2' doesn't exist on type 'User'",
    "Field 'projectsV2' doesn't exist on type 'Repository'",
    "Field 'projectsV2' doesn't exist on type 'Organization'",
    "Field 'projectItems' doesn't exist on type 'Issue'",
    "Field 'projectItems' doesn't exist on type 'PullRequest'",
];

fn project_items_of(node: &Obj) -> Json {
    let status = strukt(vec![("optionId", Shape::Str), ("name", Shape::Str)]);
    Json::Arr(
        nodes_of(node.get("projectItems"))
            .iter()
            .map(|item| {
                let mut out = Obj::new();
                out.set("status", exported(item.get("status"), &status));
                out.set("title", item.get("project").get("title").text());
                Json::Obj(out)
            })
            .collect(),
    )
}

pub(crate) fn plain(name: &'static str, shape: Shape) -> (&'static str, Field) {
    (
        name,
        Field {
            select: name.to_owned(),
            export: Export::Plain(name, shape),
            view: None,
            pages: None,
        },
    )
}

pub(crate) fn plain_as(name: &'static str, shape: Shape, select: &str) -> (&'static str, Field) {
    (
        name,
        Field {
            select: select.to_owned(),
            export: Export::Plain(name, shape),
            view: None,
            pages: None,
        },
    )
}

pub(crate) fn nodes(
    name: &'static str,
    select: &str,
    item: Shape,
    pages: Option<Pages>,
) -> (&'static str, Field) {
    (
        name,
        Field {
            select: select.to_owned(),
            export: Export::Nodes(name, item),
            view: None,
            pages,
        },
    )
}

pub(crate) fn custom(
    name: &'static str,
    select: &str,
    export: fn(&Obj) -> Json,
    pages: Option<Pages>,
) -> (&'static str, Field) {
    (
        name,
        Field {
            select: select.to_owned(),
            export: Export::Custom(export),
            view: None,
            pages,
        },
    )
}

pub(crate) fn paged(name: &'static str, select: fn(&str) -> String) -> Pages {
    Pages {
        select: Select::Of(select),
        at: At::Named(name),
    }
}

fn references_select(name: &str, after: &str) -> String {
    format!(
        "{name}(first: 100{after}) {{nodes {{id,number,url,repository {{id,name,owner {{id,login}}}}}}pageInfo{{hasNextPage,endCursor}}}}"
    )
}

/// A list of references to issues or pull requests in some repository:
/// always a list, read to its end.
pub(crate) fn references(name: &'static str) -> (&'static str, Field) {
    (
        name,
        Field {
            select: references_select(name, ""),
            export: Export::References(name),
            view: None,
            pages: Some(Pages {
                select: Select::References(name),
                at: At::Named(name),
            }),
        },
    )
}

/// The fields issues and pull requests share.
pub(crate) fn shared_fields() -> FieldTable {
    vec![
        nodes(
            "assignees",
            "assignees(first:100){nodes{id,login,name},totalCount}",
            user(),
            None,
        ),
        plain_as("author", Shape::Author, "author{login,...on User{id,name}}"),
        plain("body", Shape::Str),
        plain("closed", Shape::Bool),
        plain("closedAt", Shape::Raw),
        nodes(
            "comments",
            &comments(""),
            comment(),
            Some(paged("comments", comments)),
        ),
        plain("createdAt", Shape::Time),
        plain("id", Shape::Str),
        nodes(
            "labels",
            "labels(first:100){nodes{id,name,description,color},totalCount}",
            label(),
            None,
        ),
        plain_as(
            "milestone",
            pointer(vec![
                ("number", Shape::Int),
                ("title", Shape::Str),
                ("description", Shape::Str),
                ("dueOn", Shape::Raw),
            ]),
            "milestone{number,title,description,dueOn}",
        ),
        plain("number", Shape::Int),
        nodes(
            "projectCards",
            "projectCards(first:100){nodes{project{name}column{name}},totalCount}",
            project_card(),
            None,
        ),
        (
            "projectItems",
            Field {
                select: PROJECT_ITEMS.to_owned(),
                export: Export::Custom(project_items_of),
                view: Some(View::Apart),
                pages: Some(paged("projectItems", project_items_alone)),
            },
        ),
        plain_as(
            "reactionGroups",
            Shape::Reactions,
            "reactionGroups{content,users{totalCount}}",
        ),
        plain("state", Shape::Str),
        plain("title", Shape::Str),
        plain("updatedAt", Shape::Time),
        plain("url", Shape::Str),
    ]
}

fn unique<'a>(names: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
    let mut seen = HashSet::new();
    names
        .into_iter()
        .filter(|name| seen.insert(*name))
        .collect()
}

/// The GraphQL selection for the fields named, in their order, each
/// once. A view leaves out the fields it reads some other way.
pub(crate) fn selection(table: &FieldTable, wanted: &[String], for_view: bool) -> String {
    unique(wanted.iter().map(String::as_str))
        .into_iter()
        .map(|name| spec(table, name))
        .filter(|field| !(for_view && field.view.is_some()))
        .map(|field| field.select.as_str())
        .collect::<Vec<_>>()
        .join(",")
}

fn export(field: &Field, node: &Obj) -> Json {
    match &field.export {
        Export::Plain(name, shape) => exported(node.get(name), shape),
        Export::Nodes(name, item) => exported(node.get(name).get("nodes"), &list_of(item.clone())),
        Export::References(name) => Json::Arr(
            nodes_of(node.get(name))
                .iter()
                .map(|item| exported(item, &reference()))
                .collect(),
        ),
        Export::Custom(of) => of(node),
    }
}

/// One answer as gh exports the fields asked for.
pub(crate) fn exported_node(table: &FieldTable, node: &Obj, wanted: &[String]) -> Json {
    let mut out = Obj::new();
    for name in wanted {
        out.set(name.as_str(), export(spec(table, name), node));
    }
    Json::Obj(out)
}

/// What a view reads its later pages through.
pub(crate) enum Fetch<'a> {
    Pull {
        target: &'a RepoRef,
        number: i128,
    },
    Issue {
        target: &'a RepoRef,
        number: i128,
        pull: bool,
    },
}

impl Fetch<'_> {
    async fn get(&self, account: &Account, select: &str, cursor: Option<&str>) -> Result<Obj> {
        match self {
            Fetch::Pull { target, number } => {
                pull_request_fields(account, target, *number, select, cursor).await
            }
            Fetch::Issue {
                target,
                number,
                pull,
            } => {
                let halves = if *pull {
                    IssueSelections {
                        issue: String::new(),
                        pull: select.to_owned(),
                    }
                } else {
                    IssueSelections {
                        issue: select.to_owned(),
                        pull: String::new(),
                    }
                };
                issue_fields(account, target, *number, &halves, cursor).await
            }
        }
    }
}

static NOTHING: Json = Json::Null;

/// The context connection of the one commit a status rollup reads.
pub(crate) fn contexts(node: &Obj) -> &Json {
    nodes_of(node.get("statusCheckRollup"))
        .first()
        .map_or(&NOTHING, |item| {
            item.get("commit").get("statusCheckRollup").get("contexts")
        })
}

fn connection(at: At, node: &Obj) -> &Json {
    match at {
        At::Named(name) => node.get(name),
        At::Contexts => contexts(node),
    }
}

fn set_nodes(at: At, node: &mut Obj, rows: Vec<Json>) {
    let slot = match at {
        At::Named(name) => node.find_mut(name),
        At::Contexts => contexts_mut(node),
    };
    if let Some(Json::Obj(obj)) = slot {
        obj.set("nodes", rows);
    }
}

fn contexts_mut(node: &mut Obj) -> Option<&mut Json> {
    let Json::Obj(rollup) = node.find_mut("statusCheckRollup")? else {
        return None;
    };
    let Json::Arr(items) = rollup.find_mut("nodes")? else {
        return None;
    };
    let Json::Obj(item) = items.first_mut()? else {
        return None;
    };
    let Json::Obj(commit) = item.find_mut("commit")? else {
        return None;
    };
    let Json::Obj(status) = commit.find_mut("statusCheckRollup")? else {
        return None;
    };
    status.find_mut("contexts")
}

async fn read_to_end(
    account: &Account,
    fetch: &Fetch<'_>,
    node: &mut Obj,
    pages: Pages,
) -> Result<()> {
    let first = connection(pages.at, node);
    let mut rows: Vec<Json> = nodes_of(first).to_vec();
    let mut info = first.get("pageInfo").clone();
    while info.get("hasNextPage").truthy() {
        let Some(cursor) = info.get("endCursor").as_str().map(str::to_owned) else {
            break;
        };
        let answer = fetch
            .get(account, &pages.select.text(AFTER), Some(&cursor))
            .await?;
        let page = connection(pages.at, &answer);
        rows.extend(nodes_of(page).iter().cloned());
        info = page.get("pageInfo").clone();
        if info.get("endCursor").as_str() == Some(cursor.as_str()) {
            return value("GitHub returned a non-advancing cursor");
        }
    }
    set_nodes(pages.at, node, rows);
    Ok(())
}

async fn project_items_apart(account: &Account, fetch: &Fetch<'_>, pages: Pages) -> Result<Json> {
    let read = async {
        let mut node = fetch.get(account, &pages.select.text(""), None).await?;
        read_to_end(account, fetch, &mut node, pages).await?;
        Ok::<Obj, Failure>(node)
    };
    match read.await {
        Ok(node) => Ok(connection(pages.at, &node).clone()),
        Err(Failure::Value(message))
            if PROJECTS_V2_IGNORABLE
                .iter()
                .any(|refusal| message.contains(refusal)) =>
        {
            let mut empty = Obj::new();
            empty.set("nodes", Json::Arr(Vec::new()));
            Ok(Json::Obj(empty))
        }
        Err(Failure::Api(mut error)) => {
            error.built_query = true;
            Err(Failure::Api(error))
        }
        Err(failure) => Err(failure),
    }
}

/// Finish reading a view's answer: every connection gh follows read to
/// its end, and the fields it reads apart read that way.
pub(crate) async fn read_rest(
    account: &Account,
    table: &FieldTable,
    mut node: Obj,
    wanted: &[String],
    fetch: &Fetch<'_>,
) -> Result<Obj> {
    for name in unique(wanted.iter().map(String::as_str)) {
        let field = spec(table, name);
        let Some(pages) = field.pages else { continue };
        if field.view == Some(View::Apart) {
            let items = project_items_apart(account, fetch, pages).await?;
            node.set(name, items);
        } else {
            read_to_end(account, fetch, &mut node, pages).await?;
        }
    }
    Ok(node)
}
