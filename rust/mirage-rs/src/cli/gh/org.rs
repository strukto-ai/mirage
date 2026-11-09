// Follows gh 2.85.0's pkg/cmd/org (MIT; see licenses/third_party/gh.txt).

use super::accessor::{Flags, Out};
use crate::core::github::client::{Account, Result, usage};
use crate::core::github::json::Obj;
use crate::core::github::repo::{current_login, graphql_data};

const LIST_QUERY: &str = "query OrganizationList($user: String!, $limit: Int!, $endCursor: String) {\n\t\tuser(login: $user) {\n\t\t\tlogin\n\t\t\torganizations(first: $limit, after: $endCursor) {\n\t\t\t\ttotalCount\n\t\t\t\tnodes {\n\t\t\t\t\tlogin\n\t\t\t\t}\n\t\t\t\tpageInfo {\n\t\t\t\t\thasNextPage\n\t\t\t\t\tendCursor\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}";

pub(crate) async fn list_cmd(account: &Account, flags: &Flags) -> Result<Out> {
    let limit = flags.as_int("limit").unwrap_or(30);
    if limit < 1 {
        return usage(format!("invalid limit: {limit}"));
    }
    let user = current_login(account).await?;
    let mut out = String::new();
    let mut count = 0;
    let mut page_limit = limit.min(100);
    let mut cursor: Option<String> = None;
    loop {
        let mut variables = Obj::new();
        variables.set("user", user.as_str());
        variables.set("limit", page_limit);
        if let Some(cursor) = &cursor {
            variables.set("endCursor", cursor);
        }
        let data = graphql_data(account, LIST_QUERY, variables).await?;
        let page = data.get("user").get("organizations");
        for org in page.get("nodes").items() {
            out.push_str(org.get("login").text());
            out.push('\n');
            count += 1;
            if count == limit {
                return Ok(Out::text(out));
            }
        }
        if page.get("nodes").items().is_empty() || !page.get("pageInfo").get("hasNextPage").truthy()
        {
            return Ok(Out::text(out));
        }
        cursor = page
            .get("pageInfo")
            .get("endCursor")
            .as_str()
            .map(str::to_owned);
        page_limit = page_limit.min(limit - count);
    }
}
