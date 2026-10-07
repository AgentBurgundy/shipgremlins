# Owning-PM delivery and production completion

ShipGremlins moves approved work from coding through **PM QA** to a **promotion PR**. Individual coding drafts do not require a routine manual review in the promotion workflow: the controller checks and integrates them, and the PM that owns the mandate tests the deployed app. Failed acceptance checks return to a coder with the PM's evidence. Production release remains a separate decision.

## Configure the workflow

New projects default to the promotion workflow with three distinct branches: integration (`pm-staging`), staging (`staging`), and production (`main`). In **Projects → Project settings**, review these branches and configure browser verification against integration. Existing projects retain their configured workflow; an explicit pull-request workflow still asks the owner to review coding drafts. Open **Changes** for the current checks, deployment, PM QA, coding follow-up and promotion status. Vercel and Railway targets must report the actual ready deployment ID, Git branch and full commit SHA. A URL alone cannot establish this provenance.

**Changes** centers on one promotion batch. Each ticket is tested separately by its owning PM; passing tickets accumulate in the same project PR, whether the batch contains one change or a dozen. The owner reviews that batch. Tickets still in coding, deployment or QA appear in a compact secondary list with their actual blocker when one exists. Each ticket has one current status; earlier attempts remain in Activity history. A recorded PR link is only presented as ready for review when its current source-control state is confirmed open. A ticket is marked included only when its recorded promotion matches that PR and its current commit. Older promotions and stale inclusion evidence are shown separately.

Create or reuse an isolated, nonproduction integration environment in the hosting provider. ShipGremlins does not create paid hosting resources or modify production settings. In Railway, select the app's project, environment and service in project settings; a project token is scoped to its environment. For GitLab source, select the correct GitLab account/repository independently of the Railway connection.

Each approved Linear issue must belong to the owning PM's mapped project/team, carry its area label and `pm-approved`, and contain an explicit `## Acceptance criteria` section with a finite bullet or numbered list. Earlier `Acceptance criteria and verification` headings and numbered headings are also accepted; narrative alone is not a finite review set. Coding admission captures the complete ticket scope before launch. Changing the approved scope, account, repository or mandate invalidates its later delivery authorization.

In promotion mode, the PM self-approves ordinary work within its adopted mandate and decomposes larger improvements into testable tickets. The owner reviews the promotion batch, not each ticket or integration draft. Explicit owner holds, review-only mandates and configured automation boundaries remain in force. New projects reserve only CI execution configuration (`.github/workflows/`, `.gitlab-ci.yml`, `.gitlab/`) as an automation boundary; ordinary application prompts are called out in the promotion's **Look closely** section. Existing custom boundaries are preserved. Work outside these limits stays excluded rather than prompting a manual integration merge.

## Keeping the PM test branch current

For projects configured for promotion with browser verification, the local dashboard reconciles **staging → integration** on startup and every minute while it is running. With the usual branch names, that is `staging → pm-staging`. The sync runs independently of PM patrol schedules. Projects using the ordinary pull-request workflow are left unchanged.

When staging has changes missing from integration, ShipGremlins creates an immutable snapshot branch for that staging revision and opens or reuses its sync PR/MR. It checks the current source and target commits, mergeability and branch checks before merging. It uses a **merge commit** to preserve staging ancestry, so the same changes do not keep appearing as new work. Provider cleanup can remove the snapshot branch after merge without deleting staging. A pending or failed check holds the sync; it does not bypass branch protections or rewrite either branch.

Conflicts are handed to a local coding worker with a bounded repair task. A repair still goes through the sync PR/MR and its checks. After two unsuccessful repair attempts, the controller stops retrying the model and reports the blocker for review. It does not repeatedly launch coding agents against the same unresolved conflict.

Changing preview access or test-account settings does not restart a staging repair. Sync retains its repository and branch identity, then checks the currently selected deployment before PM testing resumes. Upgrades recover an earlier repair only when its saved admission, project identity and source revisions match; an ambiguous repair is held instead of starting a duplicate.

After the merge, PMs wait for a ready integration deployment matching the updated branch commit. The controller checks the actual deployment branch and full SHA before admitting a PM run. An old but reachable preview cannot satisfy this gate. This keeps PM investigations on the app that includes the latest staging changes.

Open **Changes → Advanced delivery workflow** to see the current sync status, its PR/MR and the last check time. **Retry sync** requests a fresh reconciliation without waiting for the next automatic check. The status distinguishes waiting for branch checks, conflict repair, deployment readiness and a blocker that needs attention.

## The delivery sequence

1. **Coding draft.** The worker runs configured checks and publishes a unique `gremlins/job-*` draft. The controller records the actual source-provider PR/MR and original approved ticket snapshot, then automatically attempts integration. Draft is the publication state, not a request to manually approve each implementation. A model-container result cannot authorize a merge by itself. This never marks the ticket Done.
2. **Integration merge.** The controller admits at most one exact-head implementation at a time. The registered approval and owning PM must still match, mergeability must be clean, and the existing integration deployment must be healthy. A file outside the PM's path map does not force a separate owner review; sensitive `ownerOnlyPrefixes` are collected in the promotion PR's **Look closely** section. Files explicitly reserved by `tiers.hubOwnerOnly`, or an empty/uninspectable diff, hold integration for owner attention. Explicit provider pending/failed checks also hold the merge. Where provider CI reports no checks, the controller runs configured checks for the published implementation SHA and current integration SHA in independent, fresh Docker checkouts. GitHub Actions and GitLab CI are not required for this path; the controller needs access to Docker for these independent checks even when coding runs on a remote worker.
3. **Deployment wait.** The exact merged implementation must be contained in the current ready integration deployment. Missing branch/SHA metadata, a moving branch, unsuccessful checks or deployment failure prevents verification. Ordinary PM observation can continue while delivery review waits, provided staging sync is current and the integration deployment matches the current branch commit.
4. **Owning PM QA.** The controller detects a ready integration deployment containing approved merged work with passing checks. It queues the owning PM once for that deployment and scope, independently of its patrol schedule. The run receives the exact deployment and every approved acceptance criterion. The PM investigates with Playwright and proposes bounded browser recipes. Once its entire model container has stopped, a separate trusted replay container reads the recipe and uses a fresh output volume. It has no model or source-control credentials and cannot execute repository scripts. It captures real PNGs and binds receipts to the job, deployment, commit and criterion. The controller uses this independent result, validates screenshot hashes and rechecks provider deployment metadata. Model-written proofs cannot authorize promotion.
5. **Coding follow-up when QA fails.** Reproducible failed acceptance criteria return to a coder with the assertion, expected result, URL and screenshot evidence. The retry remains bound to the original approved scope; it cannot expand the ticket. Its replacement draft goes through integration checks and a fresh owning-PM review. One automatic coding repair is allowed for the original change and its descendants: two implementations total. Cancellation, changed approval or configuration, exhausted attempts, or an unsuccessful repair remains visible as a stopped follow-up. Missing evidence, inaccessible environments and infrastructure failures are blockers, not instructions to invent an application fix.
6. **Project promotion.** Passing PM QA queues promotion preparation automatically. The controller collects verified work across the project's PMs into one promotion PR, cherry-picking only approved changes onto staging's current base. Unverified/failed changes, dependencies and conflicts remain held. Configured install/lint/typecheck/test/build commands run against the assembled candidate in a fresh unprivileged Docker container. When these checks pass, the controller creates or updates a ready staging PR/MR. Any explicitly configured candidate verifier remains an additional required gate. Integration screenshots prove the tested integration deployment; they are not presented as browser evidence for the assembled staging candidate. Source credentials remain in controller Git processes; application scripts never execute on the controller host. Candidate check logs and owned checkouts remain available under `.run/delivery/PROJECT/candidates/`.
7. **Production completion.** In Delivery, the owner selects every deliverable for each ticket, the staging-to-production PR/MR, and a completed Linear state, then explicitly confirms that this is the complete approved scope. The controller stores this finite declaration with a revision guard. Later reconciliation verifies the actual production merge and exact Git-tree inclusion before applying Done. A staging merge, successful PM run, label or comment alone cannot do this. Canceled issues and changed scopes are preserved.

Before an implementation has entered integration, a reproducible conflict or failed code check can receive one automatic integration repair. The controller preserves the old draft, registers the replacement, and checks the replacement's exact revision before merge. This is separate from the single repair allowed after failed PM QA; no old test receipts transfer to the replacement. Active repairs, deployment waits and PM tests appear in Changes, while the inbox asks for attention only when delivery is blocked or a repair has stopped.

## Authenticated browser reviews

The PM can reuse a real test-account login by writing Playwright storage state to the private handoff `/output/.review-sessions/ROLE.json`, then referencing that role in `/output/pm-review-request.json`. Only cookies for the admitted hostname and localStorage for the exact deployment origin are accepted. Recipes may include up to twelve selector-based click, fill, select, check or uncheck actions per criterion. The replay phase deletes its consumed writable copies; the original handoff stays in the owned output volume for restart-safe replay until job cleanup. Private recipes and sessions are excluded from dashboard artifacts, history and ordinary remote uploads. Retained receipts omit input values.

Each criterion runs in a fresh browser context. Supported outcomes are exact text visible/absent, selector visible/absent and final pathname. Cross-origin document navigation is blocked; bypass credentials are sent only through a single-hop request to the admitted origin, never forwarded across redirects. Unsupported API assertions, cross-origin authentication or flows without reproducible test accounts remain explicitly blocked. A trivial assertion that does not exercise the acceptance criterion is not a sound PM review; owner review of evidence still matters.

## Optional candidate browser verification

The default promotion path uses owning-PM browser receipts and checks on the assembled code. It does not require a separate signing service to publish the promotion PR. Teams that need browser verification of the assembled candidate can configure a candidate deployment and trusted signer using [verification setup](VERIFICATION.md). Once configured, this extra gate must pass before the promotion is published. A promotion PR does not itself authorize a production merge.

Preparing a candidate builds, checks and pushes its branch. **It does not provision or deploy a separate Railway candidate environment, and it does not create its own signing authority.**

Vercel branch deployments can provide a candidate preview. A fixed Railway `pm-staging` service remains the integration target; it cannot simultaneously prove a different cherry-picked candidate. Use a separate candidate service/environment or external candidate deployment automation. Railway's documented `serviceInstanceDeployV2(commitSha)` validates the SHA against a connected GitHub repository. GitLab source uploads use `railway up`; a redeploy reuses existing source and must never be treated as proof of a newly assembled GitLab candidate. The controller does not invent a deployed SHA from a branch label. An automatic source-upload/candidate-replay path is not implemented in this release.

### One-time Railway candidate setup

Keep the existing integration service selected for browser verification. Add a second named Railway target pointing at an existing nonproduction candidate service/environment, then select it under **Changes → Advanced delivery workflow → Candidate environment**. The corresponding configuration is:

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

The following steps are an optional advanced setup for a separately signed candidate environment. Ordinary PM-tested batch promotion runs automatically and does not require this setup.

1. Open **Advanced delivery workflow** and click **Prepare promotion**, or use the candidate handoff already produced by automatic preparation. Copy that unsigned handoff from Delivery. It contains `project`, `repo`, `author`, `area`, `branch`, `releaseBranch`, `candidateSha`, `baseSha`, `changes` and `preparedAt`; it contains no credentials or local checkout path.
2. In a trusted deployment job, fetch that exact candidate branch and check that `git rev-parse HEAD` equals `candidateSha`. For GitLab, an existing Railway source-upload job can then run `railway up --project YOUR_PROJECT_ID --environment CANDIDATE_ENV_ID --service CANDIDATE_SERVICE_ID` from that checkout. Keep the candidate service separate from integration. The provider must report the exact deployed SHA and branch; a successful upload alone is insufficient, and metadata that cannot be verified holds promotion.
3. Run the trusted browser verifier against the ready candidate, including cross-feature regressions. Copy the handoff identity fields into the [attestation draft](VERIFICATION.md#candidate-verification), add the actual deployment/assertions/screenshots and local artifact paths, and sign it with `gremlins evidence sign --input /evidence/draft.json --output /evidence/signed.json`. Only this trusted signer receives `SHIPGREMLINS_ATTESTATION_KEY`.
4. Configure the controller process with `SHIPGREMLINS_VERIFICATION_FILE=/evidence/signed.json` and `SHIPGREMLINS_ATTESTATION_PUBLIC_KEY` containing the public PEM. Make the signed file and referenced artifacts available at those paths, then retry **Prepare promotion**. The UI handoff's `area` and `preparedAt` describe preparation; the signing draft uses the identity fields documented in the verification schema.

Retries reuse an existing candidate with the same Git tree and staging base, so a later attestation can match the originally prepared SHA. A changed staging base, delivery set, candidate tree, deployment or expired evidence requires a fresh test. Selecting a candidate environment or changing execution limits does not invalidate an already captured integration approval; changing integration/source/ownership scope does. Selection configures lookup only: it does not configure Railway branch routing, upload code, provision resources or install a signer.

## Persistence, retries and boundaries

`.run/delivery/PROJECT/` holds approval admissions, the delivery/review ledger, exact local check receipts, candidate checkouts/logs, `candidate-handoffs/AREA.json` and owner production declarations. Files are private, bounded, written atomically where replaced, and guarded against symlinks. Controller restarts retain records. Reconciliation retries inspect existing PRs and artifacts rather than rerunning a model that already published a draft. A confirmed dead process lock is recoverable; ambiguous or corrupt state is preserved for repair.

Local integration check receipts bind SHA, command configuration and worker image, and expire after 24 hours; failures are cached for five minutes to avoid continuous rebuilds. Provider failure or pending status always overrides local success. New work under a ticket invalidates an earlier declaration that no longer lists every tracked delivery. Declaration completeness is an owner assertion; ShipGremlins cannot infer undisclosed work.

Automatic promotion intents live in `.run/delivery/automatic.json`, keyed by the verified delivery IDs and review hashes. A newer review stays queued while a prior preparation runs. Restart resumes pending work or a claim whose controller process has exited; an ambiguous live owner is preserved. Retryable preparation holds use exponential backoff from one minute up to thirty minutes, retained across restarts. These controller retries do not start additional AI runs. Explicit Prepare promotion remains available; the separate one-repair limit still bounds coding retries after failed PM QA. This store supports up to 200 project/PM pairs.

The authenticated dashboard uses `GET /api/projects/NAME/delivery`, `POST .../delivery/sync`, `POST .../delivery/advance`, `POST .../delivery/promote`, `GET .../delivery/states` and `POST .../delivery/production`. Sync retry takes an empty object and uses the project's existing branch configuration. Production confirmation requires the current `revision`, `deliveryIds`, `productionPr`, `completedStateId` and `scopeComplete: true`. Provider mutations and credentials stay in the controller. Workers cannot declare completion, edit protections, merge production or authorize their own promotion.

## Provider references

- [GitLab merge requests API](https://docs.gitlab.com/api/merge_requests/): exact-head merge, MR state and paginated changed-file evidence.
- [GitLab repositories API](https://docs.gitlab.com/api/repositories/): exact revision trees and comparisons.
- [GitLab pipelines API](https://docs.gitlab.com/api/pipelines/) and [jobs API](https://docs.gitlab.com/api/jobs/): pending, skipped/manual and failed jobs do not count as an unconditional pass.
- [Railway service management API](https://docs.railway.com/integrations/api/manage-services): deployment by connected GitHub SHA and existing-source redeployment.
- [Railway CLI deployment](https://docs.railway.com/cli/deploying): source upload and environment-scoped project tokens.
- [Playwright route API](https://playwright.dev/docs/api/class-route): redirected header behavior and explicit single-hop fetch handling.
