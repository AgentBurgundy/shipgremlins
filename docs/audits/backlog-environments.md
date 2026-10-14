# Completed environment backlog: 024 and 025

Date: 2026-10-14. These changes preserve existing configuration and require no external provisioning.

## 024 — Import a supported Compose stack

Implemented a deterministic repository importer, available from **Project setup → Import Compose from repository**. It uses saved source access without Claude, Docker, shell execution or loading the host's `.env`. An optional repository path selects a specific Compose file. Imported source stays at one full commit SHA. Review the result and choose **Use this disposable recipe**, then save and verify it through the existing environment flow.

The supported subset is one application built from a tracked regular Dockerfile or a trusted image, one internal HTTP port, an optional explicit command argument array, and optional Postgres 16 / Redis 7 services. Application connection URLs pointing to those Compose service names become injected URLs for fresh disposable databases. Named database data volumes become ephemeral storage. Public literal build arguments are preserved. Other runtime inputs become dedicated `TEST_COMPOSE_*` Connection references; original credentials are never copied into project settings or reports. HTTP health URLs can become the managed health path.

Unsupported settings produce explicit diagnostics and no applicable target: host/bind mounts, Docker socket mounts, privilege or device access, host/external/customized networks, extra application containers, external volumes, inherited host inputs, custom entrypoints, shell command strings, remote build contexts, credential/interpolated build arguments, and unsupported service images. YAML aliases, duplicate keys, custom tags, oversized documents and incomplete repository trees are rejected. Saving an imported Docker recipe checks that source has not advanced since import.

Bounds: up to four Compose files by automatic detection, six services per document, 64 KiB per document, and one application plus at most one of each supported database in a translated recipe. A specific path can select another file. GitLab trees are bounded to 500 entries; GitHub tree responses use the existing bounded source transport. This is a deliberately supported Compose subset, not arbitrary Compose execution. Database migrations and synthetic seeds remain explicit recipe commands; existing source database data is never attached.

Code: `src/projectOnboarding/compose.ts`, controller `importCompose()` in `index.ts`, and `dashboard/project-onboarding.js`. Tests cover pinned source, source changes, symlinks, supported URL translation, secret exclusion, unsupported features, bounded YAML parsing, and import → review → configure in the actual UI module.

## 025 — Separate public build arguments and ephemeral build secrets

Implemented top-level Docker recipe fields:

```json
{
  "buildArgs": {
    "NEXT_PUBLIC_API_URL": "https://staging.example.test"
  },
  "buildSecrets": {
    "npmrc": "TEST_NPMRC"
  }
}
```

`buildArgs` contains explicitly public literal values. Credential-like names, private token/key formats, credential-bearing URLs, host interpolation and known saved credential values are rejected. Build arguments are retained build metadata, so secrets belong in `buildSecrets` instead.

`buildSecrets` maps a bounded BuildKit mount id to a dedicated `TEST_*` Connection reference. Its resolved value travels only to the build environment preparation layer. The runner writes each value to a private ephemeral file outside the archive build context, passes the path with `--secret type=file,id=…,src=…`, enables BuildKit, and removes the files immediately after build success or failure. The containing private directory is removed on all startup exits. Build secret values never appear in Docker arguments, generated Dockerfiles, AI prompts, runtime environment variables, model payloads or returned build errors. Existing Dockerfiles consume the mount with `RUN --mount=type=secret,id=npmrc`; the controller does not rewrite application code or insert secrets into Dockerfile instructions.

Build-only Connections support bounded multiline text, remain separate from runtime credentials, appear as required inputs, and participate in project credential classification and browser-evidence invalidation. A reference also used for runtime inputs retains the stricter runtime single-line rules. Credential values containing all three dotenv quote styles must be supplied through the controller environment because the existing credential-file format cannot represent those values safely.

Code: `src/testEnvironments/recipe.ts` and `index.ts`; source-analysis schema and UI recipe editing; `projectCapabilities.ts`, `credentialScope.ts`, `connections.ts`, `environmentAccess.ts`; and local Docker payload validation/wiring. Tests read the private files during build, assert values never enter arguments or worker payloads, verify immediate deletion after successful and failed builds, reject missing/undeclared/credential-bearing arguments, and confirm rotation invalidates evidence.

BuildKit prevents the mount itself from becoming an image layer. A reviewed Dockerfile must still avoid explicitly printing or copying a mounted credential; arbitrary application build instructions cannot be made trustworthy by the controller. No claim is made that a malicious Dockerfile cannot exfiltrate or copy its own inputs.

## Validation and operational limit

Focused importer, runtime, UI, credential-scope, environment access and local runner tests pass. TypeScript and lint checks are run after integration. A live build could not be exercised because Docker Desktop's Linux daemon was stopped (the Docker named pipe was absent). No provider resource, deployed environment or production data was modified.

Implementation follows Docker's documented [BuildKit secret mounts](https://docs.docker.com/build/building/secrets/) and [public build-variable behavior](https://docs.docker.com/build/building/variables/), using the YAML parser's [bounded alias handling](https://eemeli.org/yaml/).
