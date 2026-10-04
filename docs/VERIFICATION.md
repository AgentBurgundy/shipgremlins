# Browser evidence and promotion

ShipGremlins fails closed: a passing prose comment is not release authorization.
There are two independent checks. First a PM verifies each source change on a
deployment. Then a trusted verifier checks the exact candidate assembled from
those changes on the current staging base. Missing, expired, or mismatched
evidence keeps the candidate out of staging.

## Source change evidence

Use Playwright MCP to exercise every acceptance criterion on the real preview.
Capture screenshots, upload them to your controlled artifact host, and record the
actual deployment identity. `sourceSha` is the source PR's merge commit;
`testedSha` is the deployed integrated revision actually exercised. If those
differ, confirm the tested revision includes the change before issuing the record.

```json
{
  "schemaVersion": 1,
  "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "testedSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "status": "passed",
  "runId": "github-actions-12345",
  "deployment": {
    "id": "dpl_example",
    "url": "https://your-preview.example.com",
    "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "screenshots": ["https://artifacts.example.com/run-12345/permissions.png"],
  "assertions": [{ "name": "Other tenant cannot export", "status": "passed" }]
}
```

These are placeholders, not evidence. Save your real record as `browser.json`:

```sh
gremlins evidence comment --input /absolute/path/browser.json
```

Append the emitted HTML marker to the PR's human-readable test report, then post
using the bot account matching `BOT_LOGIN`. The dispatcher validates the schema,
exact source SHA, authenticated comment author, and latest verdict. A later
failure from that author revokes the pass. Keep bot credentials scoped; this
source-level author check is not an independent browser oracle.

## Candidate verification

1. Run `gremlins promote --project my-app --area core`. The dispatcher checks current
   integration health and source evidence, assembles a candidate from staging,
   runs configured install/lint/typecheck/test/build commands, and pushes a
   deployable branch. For an initial promotion with no open PR, that branch is
   `pm-release/<area>/<date>` (or a reused/suffixed release branch). When updating
   an existing promotion PR, unverified changes are staged separately on
   `pm-candidate/<area>/<full-candidate-sha>`, preserving the PR's reviewed branch
   until verification passes. Without candidate evidence the dispatcher stops
   before opening or changing a staging PR. The digest gives the candidate SHA,
   branch, staging base, release branch, and source PR numbers. A
   `Candidate verification: ` log line also exposes those coordinates as JSON.
2. Deploy that candidate branch on the target Vercel project. The configured
   Vercel integration must build both `pm-release/*` and `pm-candidate/*`
   branches as previews.
3. In a **trusted verifier job**, wait for the deployment to be READY at the exact
   candidate SHA. Test the complete candidate, including cross-feature
   regressions, using actual browser interactions and screenshots. Capture the
   staging base SHA, candidate PR set, and release branch from the preparation
   record described below. Cross-check the candidate branch's current SHA,
   staging base, change set, and actual deployment with Git and provider APIs;
   the preparation log is a handoff, not signed evidence.
4. Write an attestation draft containing the fields below. Keep screenshots beside
   the eventual signed file, referenced by relative paths. Every public screenshot
   URL in BrowserEvidence needs a matching local file entry.
5. Sign after verification. Rerun promote with the signed file and artifacts
   available to the dispatcher. A changed candidate, PR set, staging base, expired
   record, altered artifact, or newer/different deployment requires a new test.

Capture one area's preparation record without reconstructing its fields manually:

```sh
gremlins promote --project my-app --area core | tee promotion.log
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const prefix = "Candidate verification: ";
const records = readFileSync("promotion.log", "utf8").split(/\r?\n/)
  .map(line => line.trimStart()).filter(line => line.startsWith(prefix))
  .map(line => JSON.parse(line.slice(prefix.length)));
if (records.length !== 1) throw new Error("Expected one candidate record; select one --area and inspect any promotion block.");
writeFileSync("candidate.json", JSON.stringify(records[0], null, 2) + "\n", { flag: "wx" });
'
```

Use a fresh `candidate.json` for each verification attempt. The record contains
`project`, `repo`, `author`, `branch`, `releaseBranch`, `candidateSha`, `baseSha`,
and `changes`; it contains no local checkout path or credentials. These map
directly into the attestation draft. The trusted verifier adds `version`,
`issuedAt`, `expiresAt`, its observed `evidence`, and local `artifacts` after
testing. A controller block before preparation emits no candidate record.

Draft shape (this example represents an initial promotion, where `branch` and
`releaseBranch` match; use the emitted record for an existing PR update):

```json
{
  "version": 1,
  "project": "my-app",
  "repo": "your-org/your-app",
  "branch": "pm-release/core/20261004",
  "releaseBranch": "pm-release/core/20261004",
  "candidateSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "baseSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "changes": [42],
  "author": "your-bot[bot]",
  "issuedAt": "2026-10-04T12:00:00.000Z",
  "expiresAt": "2026-10-04T13:00:00.000Z",
  "evidence": {
    "schemaVersion": 1,
    "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "testedSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "status": "passed",
    "runId": "trusted-verifier-12345",
    "deployment": {
      "id": "dpl_example",
      "url": "https://candidate.example.com",
      "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    "screenshots": ["https://artifacts.example.com/12345/permissions.png"],
    "assertions": [{ "name": "Cross-tenant export denied", "status": "passed" }]
  },
  "artifacts": [
    {
      "path": "permissions.png",
      "url": "https://artifacts.example.com/12345/permissions.png"
    }
  ]
}
```

```sh
# Generate an Ed25519 key pair once in your trusted administration environment.
openssl genpkey -algorithm ED25519 -out verifier-private.pem
openssl pkey -in verifier-private.pem -pubout -out verifier-public.pem

# Inject private PEM as SHIPGREMLINS_ATTESTATION_KEY only in the trusted signer.
# Never print the private key, commit it, or pass it as a CLI argument.
gremlins evidence sign --input /evidence/draft.json --output /evidence/signed.json

# Give the dispatcher only SHIPGREMLINS_ATTESTATION_PUBLIC_KEY (the public PEM).
# It can verify signatures but cannot issue new ones.
SHIPGREMLINS_VERIFICATION_FILE=/evidence/signed.json gremlins promote --project my-app --area core
```

The signer computes local artifact SHA-256 digests and refuses overwrite. Records
have a maximum 24-hour lifetime. Verification checks Ed25519 authentication, project,
repo, author, candidate and base revisions, branch names, complete PR set,
artifact bytes, time validity, and the latest ready candidate deployment.

## Operational boundary

The alpha includes signing and verification tools, not an automatically provisioned
trusted verifier workflow. Configure that boundary before enabling promotion.
Do not add the signing key to the existing PM or developer job environment.
The signature attests what the trusted verifier reported; it cannot establish that
assertions are meaningful or screenshots truthful. The dispatcher hashes local
artifact bytes; it does not download public URLs or certify their contents. Use
immutable artifact storage and preserve the full browser trace with the job.

Existing area-selective promotions use `pm-release/*` branches into staging. A
literal whole-branch `pm-staging` → staging release mode, durable distributed
leases, required-check publisher enforcement, and automated evidence storage are
still roadmap work. Protect staging/production in your provider and keep human
merge approval enabled. “Done” is separately governed by
[production reconciliation](LINEAR_LIFECYCLE.md).
