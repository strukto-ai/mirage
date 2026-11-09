// The calls gh 2.85.0 makes for pkg/cmd/release (MIT; see
// licenses/third_party/gh.txt).

use super::client::{Account, Failure, Result, github_request, quote, value};
use super::json::{Json, Obj};
use super::repo::{RepoRef, graphql_data};

const DRAFT_BY_TAG: &str = "query RepositoryReleaseByTag($name:String!$owner:String!$tagName:String!){repository(owner: $owner, name: $name){release(tagName: $tagName){databaseId,isDraft}}}";

fn path(target: &RepoRef, tail: &str) -> String {
    format!("/repos/{}/{}/releases{tail}", target.owner, target.repo)
}

/// A release by tag, published or else a draft, as gh's FetchRelease finds
/// one: REST cannot see a draft by its pending tag, GraphQL can.
pub(crate) async fn get_release(account: &Account, target: &RepoRef, tag: &str) -> Result<Json> {
    let published = github_request(
        account,
        "GET",
        &path(target, &format!("/tags/{}", quote(tag))),
        None,
    )
    .await;
    match published {
        Err(Failure::Api(error)) if error.status == 404 => {}
        other => return other,
    }
    let mut variables = Obj::new();
    variables.set("name", target.repo.as_str());
    variables.set("owner", target.owner.as_str());
    variables.set("tagName", tag);
    let data = graphql_data(account, DRAFT_BY_TAG, variables).await?;
    let found = data.get("repository").get("release");
    if !found.get("isDraft").truthy() {
        return value("release not found");
    }
    let id = found.get("databaseId").show();
    match github_request(account, "GET", &path(target, &format!("/{id}")), None).await {
        Err(Failure::Api(error)) if error.status == 404 => value("release not found"),
        other => other,
    }
}

pub(crate) async fn get_latest_release(
    account: &Account,
    target: &RepoRef,
) -> Result<Option<Json>> {
    match github_request(account, "GET", &path(target, "/latest"), None).await {
        Ok(value) => Ok(Some(value)),
        Err(Failure::Api(error)) if error.status == 404 => Ok(None),
        Err(failure) => Err(failure),
    }
}

pub(crate) async fn create_release(account: &Account, target: &RepoRef, body: Obj) -> Result<Json> {
    github_request(account, "POST", &path(target, ""), Some(&Json::Obj(body))).await
}
