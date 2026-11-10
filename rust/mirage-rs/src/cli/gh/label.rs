// Follows gh 2.85.0's pkg/cmd/label (MIT; see licenses/third_party/gh.txt).

use super::accessor::{Flags, Out, exact_one, export_out, json_fields, named_repo, repo_for, tsv};
use crate::core::github::client::{Account, Failure, Result, github_request, quote, usage, value};
use crate::core::github::json::{Json, Obj, quoted};
use crate::core::github::repo::{RepoRef, graphql_data};
use crate::request::Request;

const LABEL_FIELDS: [&str; 8] = [
    "color",
    "createdAt",
    "description",
    "id",
    "isDefault",
    "name",
    "updatedAt",
    "url",
];
const DEFAULT_FIELDS: [&str; 3] = ["color", "description", "name"];
const RANDOM_COLORS: [&str; 16] = [
    "B60205", "D93F0B", "FBCA04", "0E8A16", "006B75", "1D76DB", "0052CC", "5319E7", "E99695",
    "F9D0C4", "FEF2C0", "C2E0C6", "BFDADC", "C5DEF5", "BFD4F2", "D4C5F9",
];
const LIST_QUERY: &str = "\n\tquery LabelList($owner: String!, $repo: String!, $limit: Int!, $endCursor: String, $query: String, $orderBy: LabelOrder) {\n\t\trepository(owner: $owner, name: $repo) {\n\t\t\tlabels(first: $limit, after: $endCursor, query: $query, orderBy: $orderBy) {\n\t\t\t\ttotalCount,\n\t\t\t\tnodes {\n\t\t\t\t\t...label\n\t\t\t\t}\n\t\t\t\tpageInfo {\n\t\t\t\t\thasNextPage\n\t\t\t\t\tendCursor\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}";

struct ListOptions<'a> {
    limit: i64,
    query: &'a str,
    order: &'a str,
    sort: &'a str,
    fields: Vec<String>,
}

async fn list_labels(
    account: &Account,
    repo: &RepoRef,
    options: &ListOptions<'_>,
) -> Result<Vec<Json>> {
    let query = format!(
        "fragment label on Label{{{}}}{LIST_QUERY}",
        options.fields.join(",")
    );
    let mut order = Obj::new();
    order.set("direction", options.order.to_uppercase());
    order.set(
        "field",
        if options.sort == "created" {
            "CREATED_AT".to_owned()
        } else {
            options.sort.to_uppercase()
        },
    );
    let mut rows = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let left = options.limit - rows.len() as i64;
        let mut variables = Obj::new();
        variables.set("owner", repo.owner.as_str());
        variables.set("repo", repo.repo.as_str());
        variables.set("orderBy", order.clone());
        variables.set("query", options.query);
        variables.set(
            "limit",
            if !(0..=100).contains(&left) {
                100
            } else {
                left
            },
        );
        if let Some(cursor) = &cursor {
            variables.set("endCursor", cursor);
        }
        let data = graphql_data(account, &query, variables).await?;
        let page = data.get("repository").get("labels");
        for node in page.get("nodes").items() {
            rows.push(node.clone());
            if rows.len() as i64 == options.limit {
                return Ok(rows);
            }
        }
        if page.get("nodes").items().is_empty() || !page.get("pageInfo").get("hasNextPage").truthy()
        {
            return Ok(rows);
        }
        cursor = page
            .get("pageInfo")
            .get("endCursor")
            .as_str()
            .map(str::to_owned);
    }
}

fn exported(node: &Json, fields: &[String]) -> Json {
    let mut out = Obj::new();
    let mut keys = fields.to_vec();
    keys.sort();
    for key in &keys {
        let value = node.get(key);
        out.set(
            key.as_str(),
            if value.is_null() {
                "".into()
            } else {
                value.clone()
            },
        );
    }
    Json::Obj(out)
}

pub(crate) async fn list_cmd(account: &Account, flags: &Flags) -> Result<Out> {
    let fields = json_fields(flags, &LABEL_FIELDS)?;
    let limit = super::accessor::limit_or_refuse(flags, 30)?;
    let search = flags.as_str("search").unwrap_or("");
    let spelled = |name: &str| account.argv_has(&format!("--{name}"));
    if !search.is_empty() && (spelled("order") || spelled("sort")) {
        return usage("cannot specify `--order` or `--sort` with `--search`");
    }
    let repo = repo_for(account, flags)?;
    let options = ListOptions {
        limit,
        query: search,
        order: flags.as_nonempty("order").unwrap_or("asc"),
        sort: flags.as_nonempty("sort").unwrap_or("created"),
        fields: fields
            .clone()
            .unwrap_or_else(|| DEFAULT_FIELDS.map(str::to_owned).to_vec()),
    };
    let rows = list_labels(account, &repo, &options).await?;
    if rows.is_empty() {
        return Ok(Out::default());
    }
    if let Some(fields) = fields {
        let selected = Json::Arr(rows.iter().map(|row| exported(row, &fields)).collect());
        return export_out(account, &selected, flags).await;
    }
    Ok(Out::text(
        rows.iter()
            .map(|row| {
                tsv(&[
                    row.get("name").text().to_owned(),
                    row.get("description").text().to_owned(),
                    format!("#{}", row.get("color").text()),
                ])
            })
            .collect::<String>(),
    ))
}

fn labels_path(repo: &RepoRef, name: Option<&str>) -> String {
    let base = format!("/repos/{}/{}/labels", repo.owner, repo.repo);
    match name {
        Some(name) => format!("{base}/{}", quote(name)),
        None => base,
    }
}

fn already_exists(failure: &Failure) -> bool {
    let Failure::Api(error) = failure else {
        return false;
    };
    let errors = error.data.get("errors").items();
    error.status == 422
        && errors.len() == 1
        && errors[0].get("field").as_str() == Some("name")
        && errors[0].get("code").as_str() == Some("already_exists")
}

async fn update(
    account: &Account,
    repo: &RepoRef,
    name: &str,
    color: &str,
    description: &str,
    new_name: &str,
) -> Result<()> {
    let mut body = Obj::new();
    if !color.is_empty() {
        body.set("color", color);
    }
    if !description.is_empty() {
        body.set("description", description);
    }
    if !new_name.is_empty() {
        body.set("new_name", new_name);
    }
    github_request(
        account,
        "PATCH",
        &labels_path(repo, Some(name)),
        Some(&Json::Obj(body)),
    )
    .await
    .map(|_| ())
}

/// Create a label: true when it was made, false when one stood already
/// and `force` was off.
async fn create(
    account: &Account,
    repo: &RepoRef,
    name: &str,
    color: &str,
    description: &str,
    force: bool,
) -> Result<bool> {
    let mut body = Obj::new();
    body.set("color", color);
    body.set("description", description);
    body.set("name", name);
    match github_request(
        account,
        "POST",
        &labels_path(repo, None),
        Some(&Json::Obj(body)),
    )
    .await
    {
        Ok(_) => Ok(true),
        Err(failure) if already_exists(&failure) => {
            if force {
                return match update(account, repo, name, color, description, "").await {
                    Err(failure) if already_exists(&failure) => Ok(false),
                    other => other.map(|()| true),
                };
            }
            Ok(false)
        }
        Err(failure) => Err(failure),
    }
}

pub(crate) async fn create_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let name = exact_one(texts, "cannot create label: name argument required")?;
    let repo = repo_for(account, flags)?;
    let mut color = flags
        .as_str("color")
        .unwrap_or("")
        .trim_start_matches('#')
        .to_owned();
    if color.is_empty() {
        let (reply, _) = account.host.ask(Request::Now).await;
        let tick = (reply.now.unwrap_or(0.0) * 1_000_000.0) as usize;
        color = RANDOM_COLORS[tick % (RANDOM_COLORS.len() - 1)].to_owned();
    }
    let description = flags.as_str("description").unwrap_or("");
    if !create(
        account,
        &repo,
        name,
        &color,
        description,
        flags.gh_bool("force"),
    )
    .await?
    {
        return value(format!(
            "label with name {} already exists; use `--force` to update its color and description",
            quoted(name)
        ));
    }
    Ok(Out::default())
}

pub(crate) async fn edit_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let name = exact_one(texts, "cannot update label: name argument required")?;
    let color = flags.as_str("color").unwrap_or("").trim_start_matches('#');
    let description = flags.as_str("description").unwrap_or("");
    let new_name = flags.as_str("name").unwrap_or("");
    if color.is_empty() && description.is_empty() && new_name.is_empty() {
        return usage("specify at least one of `--color`, `--description`, or `--name`");
    }
    let repo = repo_for(account, flags)?;
    match update(account, &repo, name, color, description, new_name).await {
        Err(failure) if already_exists(&failure) => value(format!(
            "label with name {} already exists",
            quoted(new_name)
        )),
        Err(failure) => Err(failure),
        Ok(()) => Ok(Out::default()),
    }
}

pub(crate) async fn delete_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let name = exact_one(texts, "cannot delete label: name argument required")?;
    if !flags.gh_bool("yes") && !flags.gh_bool("confirm") {
        return usage("--yes required when not running interactively");
    }
    let repo = repo_for(account, flags)?;
    github_request(account, "DELETE", &labels_path(&repo, Some(name)), None).await?;
    Ok(Out::default())
}

pub(crate) async fn clone_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let source = exact_one(
        texts,
        "cannot clone labels: source-repository argument required",
    )?;
    let source = named_repo(account, source)?;
    let repo = repo_for(account, flags)?;
    let options = ListOptions {
        limit: -1,
        query: "",
        order: "asc",
        sort: "created",
        fields: DEFAULT_FIELDS.map(str::to_owned).to_vec(),
    };
    let force = flags.gh_bool("force");
    for row in list_labels(account, &source, &options).await? {
        create(
            account,
            &repo,
            row.get("name").text(),
            row.get("color").text(),
            row.get("description").text(),
            force,
        )
        .await?;
    }
    Ok(Out::default())
}
