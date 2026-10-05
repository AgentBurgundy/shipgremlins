# Removing local resources

Dashboard removal actions change this ShipGremlins workspace. They do not delete Git repositories, Linear teams/projects/issues, cloud services, deployments, or provider accounts.

| Resource                    | Action                                                       | What remains                                                                                                                  |
| --------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Project                     | Delete after reviewing the preview and typing its identifier | Private local recovery copy, run history, delivery evidence, worker registrations, shared credentials, and external resources |
| PM                          | Delete after reviewing the preview and typing `project/pm`   | Recovery copy of that PM's configuration/documents, other PMs, history, and external Linear resources                         |
| Named Linear/Vercel account | Remove saved account                                         | A token-free record reserving the old ID; other accounts and provider installations stay unchanged                            |
| OAuth connection            | Disconnect                                                   | The named account and project references; default accounts may still use a separately saved or exported API token             |
| Manual credential           | Clear saved token                                            | Other `.env` entries, exported environment variables, and OAuth connections                                                   |
| Owner decision              | Delete from the project's Knowledge view                     | Historical runs and previously generated evidence; future context no longer includes the deleted decision                     |
| Environment                 | Remove its project setting                                   | The hosting service/deployment and any separately saved credentials                                                           |
| Remote worker               | Revoke access                                                | Historical jobs and artifacts; the worker cannot renew its controller lease                                                   |

## Project and PM recovery

Delete previews describe what will move and which operations must finish first. Queued/running jobs and ongoing setup or delivery work block conflicting deletion. Cancel or finish that work, then refresh the preview. Revision checks prevent a stale confirmation from deleting newly edited settings.

Recovery files live under `.run/deleted/`. Deleted identifiers remain reserved so schedules, worker scopes, and historical jobs cannot silently attach to a different resource with the same name. Use **Settings → Recently deleted** to restore an archived project or PM. Restoration preserves the original recovery copy, leaves restored PMs paused, and requires project verification again. It never overwrites a different resource occupying the same location.

Deleting a project does not revoke shared OAuth connections or erase shared credentials. Another project may need them. Review Connections separately after deletion. Restoring a project whose saved account was subsequently removed requires selecting a new account before verification.

## Saved accounts and credentials

**Disconnect** drops this machine's OAuth authorization without uninstalling the provider integration. Named accounts stay available for reconnection. Running credential leases prevent disconnecting an account in use.

**Remove saved account** is available for named Linear/Vercel accounts. Projects must stop referencing the account, including legacy Vercel settings and inactive environment targets. Queued/running work must finish or be canceled first, and active credential leases must end. A single atomic encrypted update removes the account label, tokens, and pending authorization. The old ID remains reserved; reconnect under a new ID. This prevents stale requests from selecting a different account. Default accounts cannot be removed; disconnect them or clear their manual credential instead.

**Clear saved token** explicitly removes the selected allowlisted credential assignments from the workspace `.env`. Saving an empty input still means “keep the existing value.” Clear removes duplicate assignments and preserves unrelated comments, line endings, and multiline values. Saving and clearing use the same write lock and private atomic replacement; unsafe links or malformed quoting fail without modifying the file.

Clear does not change environment variables exported by your shell or service manager. If a connection remains marked **Inherited**, remove that export and restart the controller. An older controller started before this behavior was fixed may have inherited a saved token from its launcher; stop it and start it again from a fresh shell. OAuth may also keep the provider connected after a manual token is cleared.

Local removal does not rewrite existing backups or revoke a copied credential at its provider. Account removal has no “restore credentials” action; reconnect intentionally when needed. Keep workspace backups private, including the encrypted OAuth state and its separate keys.

## Environments and workers

Before removing a selected browser or promotion environment, choose another valid target or update the corresponding verification/workflow settings. Removing the setting does not destroy the Vercel project, Railway service, or Cloud Run service, and does not automatically clear a credential shared with another target.

Pause or remove idle local worker capacity through Workers. Historical jobs and output are retained. For remote workers, **Revoke** invalidates enrollment/access and stops lease renewal; an unreachable worker stops when its bounded lease watchdog expires. These actions never terminate unrelated containers or delete a cloud machine. See [Remote workers](REMOTE_WORKERS.md) for the worker service and retained-data model.
