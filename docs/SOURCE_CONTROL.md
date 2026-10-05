# Connect GitHub or GitLab

Open **Source control** in `gremlins setup`. On a homelab server, run `gremlins setup --lan` and use the dashboard from your laptop or phone. The controller stays on the server throughout authorization.

## Sign in with the official app

1. Choose **Connect GitHub** or **Connect GitLab**. The dashboard shows a short device code and a link to the provider.
2. Open that link, confirm the code, and authorize ShipGremlins. Only approve a code you just requested from your own dashboard. GitHub also needs the ShipGremlins App installed on the repositories you want the crew to access; use the installation link to select them.
3. Return to the dashboard. It polls at the provider's permitted interval and displays the connected account when authorization finishes.
4. Choose a repository from the live list, give the project a local ID, and review its staging branches, test commands, and PM mandate. Run **Verify connections** before enabling a PM.

Authorization uses the providers' device flow. The local controller exchanges and refreshes tokens directly with GitHub or GitLab; a hosted ShipGremlins token broker and an app client secret are not required. GitHub App access is constrained by both the app's repository access and the authorizing user's permissions. Actions use that user's authorization, rather than a standalone bot installation token. [GitHub user-token documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)

The GitLab app requests API and repository access so jobs can clone, push, and create merge requests. GitLab's OAuth `api` scope is broad; choosing a project in ShipGremlins does not reduce the provider token to only that project. Use an account with access appropriate for your gremlins. The repository picker and job preparation check the selected repository's access, and coding jobs require write access. [GitLab OAuth scopes](https://docs.gitlab.com/integration/oauth_provider/)

Empty repository lists can mean the GitHub App has not been installed for that repository, an organization requires approval, or the selected account lacks access. Reload after changing the installation. Lists are bounded and show when more repositories are available; an omitted entry is not a provider authorization guarantee.

## Creating a repository for an idea

The guided **I have an idea** flow creates a repository in the account or namespace
you select. **Private** is the default; public access requires an explicit choice
and final review. Existing app onboarding continues to select an existing repository.

GitHub apps and fine-grained tokens need **Repository creation (write)** or
**Administration (write)** to create repositories. Prefer Repository creation when
available. A classic token needs `repo` to create private repositories. App owners
must configure the permission, and users must accept the change. ShipGremlins does
not change provider permissions automatically. After creation, select the new
repository in the app installation if needed; Contents and Pull requests write
access are required to initialize it and run coding jobs.
[GitHub repository creation permissions](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user)

GitLab creation uses `api` access and an owned namespace where the user is allowed
to create projects. Group policies can still restrict creation or public visibility.
Account and namespace IDs, visibility, and a unique setup marker prevent a retry
from adopting an unrelated repository or switching to a different account. If a
request times out, resume the same setup. Existing repositories are never deleted
or changed to make a name available.

## Existing tokens and self-hosted GitLab

Manual `GITHUB_TOKEN` and `GITLAB_TOKEN` connections remain available under the advanced source-token form. Existing installations keep working. Exported variables take precedence over saved `.env` values for this manual-token path.

Official browser sign-in and the GitLab repository picker target **GitLab.com**. For self-hosted GitLab, use a token from that server and enter its HTTPS origin and repository path manually when creating the project, for example `https://gitlab.example.com` and `group/subgroup/app`. Verify the project before enabling jobs. A GitLab token is not interchangeable between servers; do not reuse one across GitLab.com and a private instance.

A saved OAuth connection takes precedence over a manual token for the same provider and server. If OAuth access is expired, revoked, or otherwise unsafe to refresh, jobs require attention instead of silently switching to a different credential. Disconnecting OAuth preserves separately saved manual tokens; remove those separately when retiring access. Provider revocation and local disconnection are separate actions.

## Jobs keep their credentials until publication finishes

Both providers rotate credentials in a way that can invalidate an older access token. Before launching a local job, ShipGremlins reserves a source credential with at least a 50-minute validity window; the worker's execution timeout is 45 minutes. The lease covers checks and trusted draft publication, and is released after the container has conclusively finished.

When a new job needs a refresh while another job still uses that connection, it stays queued. This does not consume its infrastructure retry or generate a failed-job notification. Docker reconciliation preserves leases across controller restarts; an ambiguous container launch is not treated as proof that the credential is unused. An orphaned lease eventually expires if the controller cannot clean it up. Reconnect and disconnect may ask you to wait for active work to finish.

Refresh tokens stay on the controller and never enter worker payloads. Workers receive only the selected access token through the existing private job handoff. External revocation or provider-side permission changes can still interrupt work. Review failed jobs before retrying them.

## Storage, backups, and updates

Source credentials live in `<configuration>/.run/source-control/`, encrypted with AES-GCM. The encryption key is stored alongside the encrypted state with restricted file permissions. Back up the entire directory together; encryption does not protect against someone who controls the server or can read both files. Credentials are not returned in dashboard status, repository lists, queue metadata, or CLI preflight output. Runtime updates preserve the directory.

The dashboard keeps pending device flows tied to its authenticated session. Expired or denied flows require a new Connect action. Losing the refresh response during a crash may require reconnection; ShipGremlins avoids retrying an ambiguous credential rotation with a possibly consumed refresh token.

Tests cover provider responses, token rotation, leases, repository checks, and HTTP boundaries using fake credentials. They do not establish permission to every real repository. Use `gremlins doctor my-app` and supervise the first PM and coding run for your project.
