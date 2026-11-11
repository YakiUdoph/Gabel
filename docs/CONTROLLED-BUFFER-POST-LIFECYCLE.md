# Controlled Buffer test-post lifecycle

Status: implemented and automated locally on 2026-11-03. One receipt-bound create/delete lifecycle was executed against Buffer on 2026-11-05; the media-repair sequence was not executed.

This operator procedure creates and removes only the disposable post used by the controlled repair test. It is not an application endpoint and cannot accept an arbitrary post for deletion.

## Operator and authorization

The cleanup operator must be an authorized member of the target Buffer account, remain present for the entire test, and be able to delete the post in Buffer's dashboard if the API is unavailable. The user must separately authorize creation and deletion. Approval of creation, media revocation, or editing does not authorize cleanup.

The test is NO-GO when no reliable cleanup operator is present or the dashboard recovery path has not been checked.

## Local files

Create the specification and receipt only under the Git-ignored `data/` directory. Do not commit or paste them into reports. A specification has this shape:

```json
{
  "runId": "unique-controlled-run-id",
  "tenantId": "local Gabel tenant ID",
  "connectionId": "tenant-owned Buffer connection ID",
  "channelId": "authorized connected X channel ID",
  "dueAt": "UTC timestamp at least 72 hours ahead",
  "originalUrl": "https://user-owned-host/original"
}
```

The tool fixes the post text to `DISPOSABLE GABEL CONTROLLED REPAIR TEST — DO NOT PUBLISH [runId]`. It permits one JPEG/PNG image, an X channel, automatic custom scheduling, no tags, and no draft/approval mode. It validates the original through Gabel's SSRF-safe probe before creation.

The receipt is HMAC-signed with Gabel's existing server-side cookie secret. It binds the exact tenant, connection, channel, post ID, due time, text, and original URL. Keep it until Buffer cleanup is independently confirmed.

## Create and verify

Run only after reviewing the specification and obtaining creation authorization:

```powershell
npm.cmd run controlled:post -- create data/controlled-post-spec.json data/controlled-post-receipt.txt
```

The tool displays only hashed identities and asks for `CREATE CONTROLLED TEST POST <runId>`. It then:

1. verifies tenant ownership of the existing encrypted Buffer connection;
2. performs fresh discovery and requires an available connected X channel;
3. validates the original public image;
4. sends one fixed-shape `createPost` mutation;
5. retrieves the created post again;
6. requires exact identity, channel, text, time, scheduled status, scheduling modes, sole image URL, empty tags, `updatePost`, and `deletePost`; and
7. saves the signed local receipt.

If Buffer returns a created post but fresh verification fails, the tool saves the receipt and reports ambiguity. Do not rerun creation. Inspect Buffer and clean up the identified post. If the mutation result itself is uncertain and contains no post identity, do not retry; use read-only discovery and the unique run ID in Buffer's dashboard.

Inspect the receipt-bound post without mutation:

```powershell
npm.cmd run controlled:post -- inspect data/controlled-post-receipt.txt
```

## Delete and confirm absence

Operational target: delete within two hours of creation. Absolute deadline: 24 hours before `dueAt`.

After separate cleanup authorization:

```powershell
npm.cmd run controlled:post -- delete data/controlled-post-receipt.txt
```

The tool asks for `DELETE CONTROLLED TEST POST <post-id>`, retrieves the exact post, compares it with the signed receipt, requires `scheduled` status and Buffer's current `deletePost` capability, and sends one deletion mutation containing only that exact ID. It then performs fresh scheduled-post discovery. It never retries automatically.

Cleanup is confirmed only when both conditions hold:

- fresh API discovery excludes the exact post ID; and
- the cleanup operator independently confirms that the post is absent from Buffer's scheduled queue.

The tool cannot perform dashboard confirmation. Record it separately without exposing the raw ID or private account information.

## Failure and recovery

- **API unavailable before creation:** do not create the post.
- **Create ambiguous:** do not retry. Use read-only discovery and the dashboard. If a matching post exists, delete it through the dashboard or the signed receipt path after separate cleanup authorization.
- **API unavailable during cleanup:** the cleanup operator must use Buffer's dashboard before the hard deadline, then confirm dashboard absence. API confirmation remains missing and cleanup is classified `PARTIAL`, not guaranteed.
- **Delete ambiguous:** do not retry. Run read-only discovery and inspect the dashboard. A further delete attempt requires a new explicit authorization.
- **Post no longer matches the receipt:** the tool refuses deletion. The operator must inspect the discrepancy and choose a separately authorized dashboard action.
- **Post is sending or sent:** do not claim cleanup. Record the failure and any resulting publication truthfully.
- **Operator unavailable or recovery infeasible:** the controlled test is NO-GO.

This tooling reduces accidental targeting; it does not guarantee cleanup, Buffer availability, or prevention of publication.

## First controlled lifecycle result — 2026-11-05

The first run, `gabel-repair-20261112`, established **POST CREATION AND CLEANUP VERIFIED; LIVE REPAIR NOT EXECUTED**.

- **LIVE API:** exactly one authorized `createPost` was freshly verified and bound to a signed receipt.
- **LIVE API:** exactly one separately authorized receipt-bound `deletePost` was sent without retry. Direct lookup returned `NOT_FOUND`, scheduled discovery excluded the receipt identity, and the marker count was zero.
- **USER-PROVIDED VISUAL EVIDENCE:** the cleanup operator supplied a Buffer dashboard screenshot showing Queue 1 with only the pre-existing November 10 post.
- **LIVE API:** the November 10 post's identity and complete retrieved-state hashes remained unchanged.
- **MISSED OPERATIONAL TARGET:** the two-hour operational cleanup target was missed. Cleanup nevertheless completed before the absolute cutoff and well before the disposable post's scheduled publication.
- `ORIGINAL_REVOKED` was never deployed, no failure was induced, no edit intent was created, no `editPost` mutation ran, and no live post-repair comparison exists.

API absence and dashboard absence are separate evidence. Together they close the disposable-post lifecycle; they do not prove a repair.

## Bounded operator-availability attestation

Operator availability is a safety prerequisite, not mutation authorization. To avoid repeatedly asking the same availability question during one uninterrupted run, accept one explicit, time-bounded statement in the active task:

`I am the cleanup operator for <runId>, have Buffer dashboard deletion access, and will remain available until <UTC expiry>. I will immediately report if that changes.`

Rules:

1. Record the run ID, statement time, expiry, and dashboard-access assertion in the run evidence. The expiry must cover the entire planned execution and cleanup window and may not extend beyond two hours from the statement.
2. Treat the attestation as current until its UTC expiry unless the user withdraws it, reports unavailability, the run identity/account changes, or the conversation is interrupted past the expiry. Read/API timeouts alone do not invalidate it.
3. Do not ask for the same availability confirmation again while the attestation remains valid. Each later mutation still requires its own explicit authorization; those authorizations also provide current evidence that the operator is present.
4. The attestation grants no permission to create, deploy/revoke, prepare an edit intent, execute `editPost`, delete a post, restore a Worker, or perform any other mutation.
5. Before revocation, require enough remaining attestation time for repair verification plus receipt-bound cleanup. If the time reserve is insufficient, do not revoke; request cleanup authorization instead.
6. Expiry or withdrawal stops new proof mutations. Existing cleanup duties remain, but cleanup still needs its separate authorization unless an already-authorized dashboard action is being completed by the operator.
