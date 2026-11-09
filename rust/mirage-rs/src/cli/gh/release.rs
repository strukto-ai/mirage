// Follows gh 2.85.0's pkg/cmd/release (MIT; see licenses/third_party/gh.txt).

use super::accessor::{
    Flags, Out, body_value, camel, export_out, json_fields, one_line, repo_for, time_field, tsv,
    typed_out,
};
use super::args::wrong_count;
use crate::core::github::client::{Account, Result, github_request, quote_ref, usage, value};
use crate::core::github::json::{Json, Obj};
use crate::core::github::release::{create_release, get_latest_release, get_release};
use crate::core::github::repo::graphql_data;

const RELEASE_FIELDS: [&str; 18] = [
    "apiUrl",
    "assets",
    "author",
    "body",
    "createdAt",
    "databaseId",
    "id",
    "isDraft",
    "isImmutable",
    "isPrerelease",
    "name",
    "publishedAt",
    "tagName",
    "tarballUrl",
    "targetCommitish",
    "uploadUrl",
    "url",
    "zipballUrl",
];

fn asset(raw: &Json) -> Json {
    let mut row = Obj::new();
    row.set("apiUrl", raw.get("url").clone());
    row.set("contentType", raw.get("content_type").clone());
    row.set("createdAt", raw.get("created_at").clone());
    row.set("digest", raw.get("digest").clone());
    row.set("downloadCount", raw.get("download_count").clone());
    row.set("id", raw.get("node_id").clone());
    row.set("label", raw.get("label").text());
    row.set("name", raw.get("name").clone());
    row.set("size", raw.get("size").clone());
    row.set("state", raw.get("state").clone());
    row.set("updatedAt", raw.get("updated_at").clone());
    row.set("url", raw.get("browser_download_url").clone());
    Json::Obj(row)
}

fn release(raw: &Json) -> Obj {
    let mut row = match camel(raw) {
        Json::Obj(row) => row,
        _ => Obj::new(),
    };
    if let Some(draft) = row.remove("draft") {
        row.set("isDraft", draft);
    }
    if let Some(pre) = row.remove("prerelease") {
        row.set("isPrerelease", pre);
    }
    if !row.has("isLatest") {
        row.set("isLatest", false);
    }
    let node_id = row.remove("nodeId");
    let id = row.remove("id");
    if let Some(id) = id {
        row.set("databaseId", id);
    }
    if let Some(node_id) = node_id {
        row.set("id", node_id);
    }
    let immutable = row.get("immutable").truthy();
    row.set("isImmutable", immutable);
    let assets: Vec<Json> = raw.get("assets").items().iter().map(asset).collect();
    row.set("assets", Json::Arr(assets));
    let mut author = Obj::new();
    author.set("id", raw.get("author").get("node_id").clone());
    author.set("login", raw.get("author").get("login").clone());
    row.set("author", author);
    for (key, from) in [
        ("apiUrl", "url"),
        ("uploadUrl", "upload_url"),
        ("tarballUrl", "tarball_url"),
        ("zipballUrl", "zipball_url"),
    ] {
        row.set(key, raw.get(from).clone());
    }
    row.set("url", raw.get("html_url").clone());
    row
}

const LIST_FIELDS: [&str; 8] = [
    "createdAt",
    "isDraft",
    "isImmutable",
    "isLatest",
    "isPrerelease",
    "name",
    "publishedAt",
    "tagName",
];
const LIST_QUERY: &str = "query RepositoryReleaseList($direction:OrderDirection!$endCursor:String$name:String!$owner:String!$perPage:Int!){repository(owner: $owner, name: $name){releases(first: $perPage, orderBy: {field: CREATED_AT, direction: $direction}, after: $endCursor){nodes{name,tagName,isDraft,immutable,isLatest,isPrerelease,createdAt,publishedAt},pageInfo{hasNextPage,endCursor}}}}";

pub(crate) async fn list_cmd(account: &Account, flags: &Flags) -> Result<Out> {
    let fields = json_fields(flags, &LIST_FIELDS)?;
    let limit = flags.as_int("limit").unwrap_or(30);
    let target = repo_for(account, flags)?;
    let drafts = flags.gh_bool("exclude_drafts");
    let pre = flags.gh_bool("exclude_pre_releases");
    let mut rows: Vec<Json> = Vec::new();
    let mut cursor = Json::Null;
    'pages: loop {
        let mut variables = Obj::new();
        variables.set(
            "direction",
            flags.as_nonempty("order").unwrap_or("desc").to_uppercase(),
        );
        variables.set("endCursor", cursor.clone());
        variables.set("name", target.repo.as_str());
        variables.set("owner", target.owner.as_str());
        variables.set("perPage", limit.min(100));
        let data = graphql_data(account, LIST_QUERY, variables).await?;
        let page = data.get("repository").get("releases");
        for node in page.get("nodes").items() {
            if (drafts && node.get("isDraft").truthy())
                || (pre && node.get("isPrerelease").truthy())
            {
                continue;
            }
            rows.push(node.clone());
            if rows.len() as i64 == limit {
                break 'pages;
            }
        }
        if page.get("nodes").items().is_empty() || !page.get("pageInfo").get("hasNextPage").truthy()
        {
            break;
        }
        cursor = page.get("pageInfo").get("endCursor").clone();
    }
    if rows.is_empty() && fields.is_none() {
        return Ok(Out::default());
    }
    if let Some(fields) = fields {
        let mut sorted = fields;
        sorted.sort();
        let selected: Vec<Json> = rows
            .iter()
            .map(|node| {
                let mut out = Obj::new();
                for field in &sorted {
                    let item = match field.as_str() {
                        "isImmutable" => node.get("immutable").clone(),
                        "publishedAt" | "createdAt" => time_field(node.get(field)).into(),
                        "name" => node.get("name").text().into(),
                        other => node.get(other).clone(),
                    };
                    out.set(field.as_str(), item);
                }
                Json::Obj(out)
            })
            .collect();
        return export_out(account, &Json::Arr(selected), flags).await;
    }
    Ok(Out::text(
        rows.iter()
            .map(|row| {
                let name = one_line(row.get("name").text());
                let title = if name.is_empty() {
                    row.get("tagName").text().to_owned()
                } else {
                    name
                };
                let badge = if row.get("isLatest").truthy() {
                    "Latest"
                } else if row.get("isDraft").truthy() {
                    "Draft"
                } else if row.get("isPrerelease").truthy() {
                    "Pre-release"
                } else {
                    ""
                };
                let published = if row.get("publishedAt").is_null() {
                    row.get("createdAt")
                } else {
                    row.get("publishedAt")
                };
                tsv(&[
                    title,
                    badge.to_owned(),
                    row.get("tagName").text().to_owned(),
                    time_field(published),
                ])
            })
            .collect::<String>(),
    ))
}

pub(crate) async fn view_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    json_fields(flags, &RELEASE_FIELDS)?;
    let tag = texts.first().map_or("", String::as_str);
    let target = repo_for(account, flags)?;
    let found = if tag.is_empty() {
        match get_latest_release(account, &target).await? {
            Some(found) => found,
            None => return value("release not found"),
        }
    } else {
        get_release(account, &target, tag).await?
    };
    let row = release(&found);
    let mut human = format!(
        "title:\t{}\ntag:\t{}\ndraft:\t{}\nprerelease:\t{}\nimmutable:\t{}\nauthor:\t{}\ncreated:\t{}\n",
        row.get("name").text(),
        row.get("tagName").text(),
        row.get("isDraft").truthy(),
        row.get("isPrerelease").truthy(),
        row.get("immutable").truthy(),
        row.get("author").get("login").text(),
        time_field(row.get("createdAt")),
    );
    if !row.get("isDraft").truthy() {
        human.push_str(&format!(
            "published:\t{}\n",
            time_field(row.get("publishedAt"))
        ));
    }
    human.push_str(&format!("url:\t{}\n", row.get("url").text()));
    for asset in row.get("assets").items() {
        human.push_str(&format!("asset:\t{}\n", asset.get("name").text()));
    }
    let body = row.get("body").text();
    human.push_str(&format!("--\n{body}"));
    if !body.ends_with('\n') {
        human.push('\n');
    }
    typed_out(account, &Json::Obj(row), flags, human, &RELEASE_FIELDS).await
}

pub(crate) async fn create_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let tag = texts.first().map_or("", String::as_str);
    if tag.is_empty() {
        return usage("tag required when not running interactively");
    }
    if texts.len() > 1 {
        return value("uploading release assets is not supported yet");
    }
    let notes = body_value(account, flags, "notes", "notes_file", false, None).await?;
    let mut body = Obj::new();
    body.set("tag_name", tag);
    if let Some(title) = flags.as_nonempty("title") {
        body.set("name", title);
    }
    if let Some(notes) = notes.filter(|notes| !notes.is_empty()) {
        body.set("body", notes);
    }
    body.set("draft", flags.gh_bool("draft"));
    body.set("prerelease", flags.gh_bool("prerelease"));
    if flags.gh_bool("generate_notes") {
        body.set("generate_release_notes", true);
    }
    if let Some(category) = flags.as_nonempty("discussion_category") {
        body.set("discussion_category_name", category);
    }
    if flags.raw("latest").is_some() {
        body.set("make_latest", flags.gh_bool("latest").to_string());
    }
    if let Some(target) = flags.as_nonempty("target") {
        body.set("target_commitish", target);
    }
    let created = release(&create_release(account, &repo_for(account, flags)?, body).await?);
    Ok(Out::text(format!("{}\n", created.get("url").show())))
}

pub(crate) async fn edit_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let [tag] = texts else {
        return wrong_count(1, texts);
    };
    let mut body = Obj::new();
    let notes = if flags.raw("notes_file").is_some() {
        body_value(account, flags, "notes", "notes_file", false, None).await?
    } else {
        flags.as_str("notes").map(str::to_owned)
    };
    if let Some(notes) = notes {
        body.set("body", notes);
    }
    if let Some(category) = flags.as_str("discussion_category") {
        body.set("discussion_category_name", category);
    }
    if flags.raw("draft").is_some() {
        body.set("draft", flags.gh_bool("draft"));
    }
    if flags.raw("latest").is_some() {
        body.set("make_latest", flags.gh_bool("latest").to_string());
    }
    if let Some(name) = flags.as_str("title") {
        body.set("name", name);
    }
    if flags.raw("prerelease").is_some() {
        body.set("prerelease", flags.gh_bool("prerelease"));
    }
    if let Some(new_tag) = flags.as_nonempty("tag") {
        body.set("tag_name", new_tag);
    }
    if let Some(commitish) = flags.as_nonempty("target") {
        body.set("target_commitish", commitish);
    }
    if body.is_empty() {
        return usage("use flags to specify properties to edit");
    }
    let target = repo_for(account, flags)?;
    let found = get_release(account, &target, tag).await?;
    if !body.has("tag_name") {
        body.set("tag_name", found.get("tag_name").text());
    }
    if let Some(new_tag) = flags
        .as_nonempty("tag")
        .filter(|_| flags.gh_bool("verify_tag"))
    {
        let mut variables = Obj::new();
        variables.set("name", target.repo.as_str());
        variables.set("owner", target.owner.as_str());
        variables.set("tagName", format!("refs/tags/{new_tag}"));
        let data = graphql_data(
            account,
            "query RepositoryFindRef($name:String!$owner:String!$tagName:String!){repository(owner: $owner, name: $name){ref(qualifiedName: $tagName){id}}}",
            variables,
        )
        .await?;
        if data
            .get("repository")
            .get("ref")
            .get("id")
            .text()
            .is_empty()
        {
            return value(format!(
                "tag {new_tag} doesn't exist in the repo {}/{}, aborting due to --verify-tag flag",
                target.owner, target.repo
            ));
        }
    }
    let path = format!(
        "/repos/{}/{}/releases/{}",
        target.owner,
        target.repo,
        found.get("id").show()
    );
    let edited = github_request(account, "PATCH", &path, Some(&Json::Obj(body))).await?;
    Ok(Out::text(format!("{}\n", edited.get("html_url").text())))
}

pub(crate) async fn delete_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let [tag] = texts else {
        return wrong_count(1, texts);
    };
    let target = repo_for(account, flags)?;
    let found = get_release(account, &target, tag).await?;
    let path = format!(
        "/repos/{}/{}/releases/{}",
        target.owner,
        target.repo,
        found.get("id").show()
    );
    github_request(account, "DELETE", &path, None).await?;
    if flags.gh_bool("cleanup_tag") {
        github_request(
            account,
            "DELETE",
            &format!(
                "/repos/{}/{}/git/refs/tags/{}",
                target.owner,
                target.repo,
                quote_ref(found.get("tag_name").text())
            ),
            None,
        )
        .await?;
    }
    Ok(Out::default())
}

pub(crate) async fn delete_asset_cmd(
    account: &Account,
    flags: &Flags,
    texts: &[String],
) -> Result<Out> {
    let [tag, name] = texts else {
        return wrong_count(2, texts);
    };
    let target = repo_for(account, flags)?;
    let found = get_release(account, &target, tag).await?;
    let Some(asset) = found
        .get("assets")
        .items()
        .iter()
        .find(|asset| asset.get("name").as_str() == Some(name.as_str()))
    else {
        return value(format!(
            "asset {name} not found in release {}",
            found.get("tag_name").text()
        ));
    };
    let path = format!(
        "/repos/{}/{}/releases/assets/{}",
        target.owner,
        target.repo,
        asset.get("id").show()
    );
    github_request(account, "DELETE", &path, None).await?;
    Ok(Out::default())
}
