# Owning-PM delivery and production completion

ShipGremlins keeps **implemented**, **verified**, **promoted**, and **Done** separate. The PM that owns the mandate reviews its fixes during a later patrol. There is no separate verification gremlin.

## Configure the workflow

In **Projects → Project settings**, choose the promotion workflow and three distinct branches: integration (commonly `pm-staging`), staging, and production. Configure browser verification against the integration environment, then open **Delivery** to manage the resulting flow. Vercel and Railway targets must report the actual ready deployment ID, Git branch and full commit SHA. A URL alone cannot establish this provenance.

Create or reuse an isolated, nonproduction integration environment in the hosting provider. ShipGremlins does not create paid hosting resources or modify production settings. In Railway, select the app's project, environment and service in project settings; a project token is scoped to its environment. For GitLab source, select the correct GitLab account/repository independently of the Railway connection.

Each approved Linear issue must belong to the owning PM's mapped project/team, carry its area label and `pm-approved`, and contain an explicit `## Acceptance criteria` section with a finite bullet or numbered list. Earlier `Acceptance criteria and verification` headings and numbered headings are also accepted; narrative alone is not a finite review set. Coding admission captures the complete ticket scope before launch. Changing the approved scope, account, repository or mandate invalidates its later delivery authorization.

## The delivery sequence

1. **Coding draft.** The worker runs configured checks and publishes a unique `gremlins/job-*` draft. The controller records the actual source-provider PR/MR and original approved ticket snapshot. A model-container result cannot authorize a merge by itself. This never marks the ticket Done.
2. **Integration merge.** The controller admits at most one exact-head implementation at a time. Approval must still be valid, changed files must be within the mandate/shared paths, protected files require owner review, mergeability must be clean, and the existing integration deployment must be healthy. Explicit provider pending/failed checks hold the merge. Where provider CI reports no checks, the controller runs configured checks for the published implementation SHA and current integration SHA in independent, fresh Docker checkouts. GitHub Actions and GitLab CI are not required for this path; the controller needs access to Docker for these independent checks even when coding runs on a remote worker.
3. **Deployment wait.** The exact merged implementation must be contained in the current ready integration deployment. Missing branch/SHA metadata, a moving branch, unsuccessful checks or deployment failure prevents verification. Ordinary PM observation can continue while delivery review waits.
4. **Owning PM review.** A later patrol receives the exact deployment and every approved acceptance criterion. The PM investigates with Playwright and proposes bounded browser recipes. Once its entire model container has stopped, a separate trusted replay container reads the recipe and uses a fresh output volume. It has no model or source-control credentials and cannot execute repository scripts. It captures real PNGs and binds receipts to the job, deployment, commit and criterion. The controller uses this independent result, validates screenshot hashes and rechecks provider deployment metadata. Model-written proofs cannot authorize promotion. Missing or failing criteria remain blocked or failed.
5. **Selective candidate.** A successful owning-PM review queues promotion preparation automatically. Prepare promotion also provides an explicit retry. Preparation cherry-picks only verified changes onto staging's current base. Unverified/failed changes, dependencies and conflicts remain held. Configured install/lint/typecheck/test/build commands run in a fresh unprivileged Docker container. Source credentials remain in controller Git processes; application scripts never execute on the controller host. Candidate check logs and owned checkouts remain available under `.run/delivery/PROJECT/candidates/`.
6. **Candidate gate.** A staging PR/MR is opened or updated only after browser evidence covers the exact assembled candidate. Integration screenshots are not candidate evidence. The existing signed verification bridge checks candidate/base/branch identity, deployment, artifacts and signer before allowing the PR. Neither integration review nor a successful build authorizes a production merge.
7. **Production completion.** In Delivery, the owner selects every deliverable for each ticket, the staging-to-production PR/MR, and a completed Linear state, then explicitly confirms that this is the complete approved scope. The controller stores this finite declaration with a revision guard. Later reconciliation verifies the actual production merge and exact Git-tree inclusion before applying Done. A staging merge, successful PM run, label or comment alone cannot do this. Canceled issues and changed scopes are preserved.

## Authenticated browser reviews

The PM can reuse a real test-account login by writing Playwright storage state to the private handoff `/output/.review-sessions/ROLE.json`, then referencing that role in `/output/pm-review-request.json`. Only cookies for the admitted hostname and localStorage for the exact deployment origin are accepted. Recipes may include up to twelve selector-based click, fill, select, check or uncheck actions per criterion. The replay phase deletes its consumed writable copies; the original handoff stays in the owned output volume for restart-safe replay until job cleanup. Private recipes and sessions are excluded from dashboard artifacts, history and ordinary remote uploads. Retained receipts omit input values.

Each criterion runs in a fresh browser context. Supported outcomes are exact text visible/absent, selector visible/absent and final pathname. Cross-origin document navigation is blocked; bypass credentials are sent only through a single-hop request to the admitted origin, never forwarded across redirects. Unsupported API assertions, cross-origin authentication or flows without reproducible test accounts remain explicitly blocked. A trivial assertion that does not exercise the acceptance criterion is not a sound PM review; owner review of evidence still matters.

## Current candidate deployment limitation

Preparing a candidate currently builds, checks and pushes its branch. **It does not provision or deploy a separate Railway candidate environment, and it does not create its own signing authority.** Configure a candidate deployment and trusted signer using [verification setup](VERIFICATION.md). Until that exact evidence exists, the UI reports the candidate as waiting and no staging PR is authorized.

Vercel branch deployments can provide a candidate preview. A fixed Railway `pm-staging` service remains the integration target; it cannot simultaneously prove a different cherry-picked candidate. Use a separate candidate service/environment or external candidate deployment automation. Railway's documented `serviceInstanceDeployV2(commitSha)` validates the SHA against a connected GitHub repository. GitLab source uploads use `railway up`; a redeploy reuses existing source and must never be treated as proof of a newly assembled GitLab candidate. The controller does not invent a deployed SHA from a branch label. An automatic source-upload/candidate-replay path is not implemented in this release.

### One-time Railway candidate setup

Keep the existing integration service selected for browser verification. Add a second named Railway target pointing at an existing nonproduction candidate service/environment, then select it under **Projects → Delivery → Candidate environment**. The corresponding configuration is:

```json
{
  "workflow": { "kind": "promotion", "candidateEnvironment": "candidate" },
  "verification": { "mode": "browser", "environment": "integration" },
  "environments": {
    "integration": {
      "kind": "railway",
      "role": "preview",
      "projectId": "your-project-id",
      "environmentId": "integration-environment-id",
      "serviceId": "integration-service-id"
    },
    "candidate": {
      "kind": "railway",
      "role": "preview",
      "projectId": "your-project-id",
      "environmentId": "candidate-environment-id",
      "serviceId": "candidate-service-id"
    }
  }
}
```

1. Click **Prepare promotion**. Copy the unsigned candidate handoff from Delivery. It contains `project`, `repo`, `author`, `area`, `branch`, `releaseBranch`, `candidateSha`, `baseSha`, `changes` and `preparedAt`; it contains no credentials or local checkout path.
2. In a trusted deployment job, fetch that exact candidate branch and check that `git rev-parse HEAD` equals `candidateSha`. For GitLab, an existing Railway source-upload job can then run `railway up --project YOUR_PROJECT_ID --environment CANDIDATE_ENV_ID --service CANDIDATE_SERVICE_ID` from that checkout. Keep the candidate service separate from integration. The provider must report the exact deployed SHA and branch; a successful upload alone is insufficient, and metadata that cannot be verified holds promotion.
3. Run the trusted browser verifier against the ready candidate, including cross-feature regressions. Copy the handoff identity fields into the [attestation draft](VERIFICATION.md#candidate-verification), add the actual deployment/assertions/screenshots and local artifact paths, and sign it with `gremlins evidence sign --input /evidence/draft.json --output /evidence/signed.json`. Only this trusted signer receives `SHIPGREMLINS_ATTESTATION_KEY`.
4. Configure the controller process with `SHIPGREMLINS_VERIFICATION_FILE=/evidence/signed.json` and `SHIPGREMLINS_ATTESTATION_PUBLIC_KEY` containing the public PEM. Make the signed file and referenced artifacts available at those paths, then retry **Prepare promotion**. The UI handoff's `area` and `preparedAt` describe preparation; the signing draft uses the identity fields documented in the verification schema.

Retries reuse an existing candidate with the same Git tree and staging base, so a later attestation can match the originally prepared SHA. A changed staging base, delivery set, candidate tree, deployment or expired evidence requires a fresh test. Selecting a candidate environment or changing execution limits does not invalidate an already captured integration approval; changing integration/source/ownership scope does. Selection configures lookup only: it does not configure Railway branch routing, upload code, provision resources or install a signer.

## Persistence, retries and boundaries

`.run/delivery/PROJECT/` holds approval admissions, the delivery/review ledger, exact local check receipts, candidate checkouts/logs, `candidate-handoffs/AREA.json` and owner production declarations. Files are private, bounded, written atomically where replaced, and guarded against symlinks. Controller restarts retain records. Reconciliation retries inspect existing PRs and artifacts rather than rerunning a model that already published a draft. A confirmed dead process lock is recoverable; ambiguous or corrupt state is preserved for repair.

Local integration check receipts bind SHA, command configuration and worker image, and expire after 24 hours; failures are cached for five minutes to avoid continuous rebuilds. Provider failure or pending status always overrides local success. New work under a ticket invalidates an earlier declaration that no longer lists every tracked delivery. Declaration completeness is an owner assertion; ShipGremlins cannot infer undisclosed work.

Automatic promotion intents live in `.run/delivery/automatic.json`, keyed by the verified delivery IDs and review hashes. A newer review stays queued while a prior preparation runs. Restart resumes pending work or a claim whose controller process has exited; an ambiguous live owner is preserved. Completed attempts, including candidate-evidence holds, require a newer review or the explicit Prepare promotion action rather than continuous rebuilding. This store supports up to 200 project/PM pairs.

The authenticated dashboard uses `GET /api/projects/NAME/delivery`, `POST .../delivery/advance`, `POST .../delivery/promote`, `GET .../delivery/states` and `POST .../delivery/production`. Production confirmation requires the current `revision`, `deliveryIds`, `productionPr`, `completedStateId` and `scopeComplete: true`. Provider mutations and credentials stay in the controller. Workers cannot declare completion, edit protections, merge production or authorize their own promotion.

## Provider references

- [GitLab merge requests API](https://docs.gitlab.com/api/merge_requests/): exact-head merge, MR state and paginated changed-file evidence.
- [GitLab repositories API](https://docs.gitlab.com/api/repositories/): exact revision trees and comparisons.
- [GitLab pipelines API](https://docs.gitlab.com/api/pipelines/) and [jobs API](https://docs.gitlab.com/api/jobs/): pending, skipped/manual and failed jobs do not count as an unconditional pass.
- [Railway service management API](https://docs.railway.com/integrations/api/manage-services): deployment by connected GitHub SHA and existing-source redeployment.
- [Railway CLI deployment](https://docs.railway.com/cli/deploying): source upload and environment-scoped project tokens.
- [Playwright route API](https://playwright.dev/docs/api/class-route): redirected header behavior and explicit single-hop fetch handling.
