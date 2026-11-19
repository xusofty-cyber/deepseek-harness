# `@deepseek-ai/dsh-nilm-service`

English | [中文](README.zh.md)

Backend BFF for the standalone NILM agent. It verifies caller envelopes, owns conversation and turn records, drives the mounted Agent through `ctx.agents`, and publishes REST plus SSE values to the caller's application or mini-program backend. It provides no login, registration, role, menu, WeChat binding, admin console, or customer-facing Web UI; the caller authenticates its own users and injects an immutable `CallContext`.

## Configuration

All deployment values come from the profile patch or `NILM_*` environment variables: bind host and port, session working directory, optional PVC sessions root, shard index and count, model provider and ids, per-tenant HMAC secrets, clock skew, nonce TTL, turn timeout, ping interval, and body limit. The package compiles no database address, secret, or model id.

## Endpoints

| Method | Path | Behavior |
| :--- | :--- | :--- |
| `POST` | `/v1/conversations` | Creates a server-issued `conversationId` |
| `GET` | `/v1/conversations` | Lists the caller's conversations, newest first |
| `GET` | `/v1/conversations/{id}/messages` | Returns the caller-visible user and assistant history |
| `POST` | `/v1/turns` | Accepts one message and returns `202` with `turnId`, `sessionId`, `conversationId`, and `streamUrl`; repeats of `clientMessageId` return the same turn |
| `GET` | `/v1/turns/{id}/stream` | SSE stream with monotonic ids, `Last-Event-ID` replay, and keepalive `ping` |
| `POST` | `/v1/turns/{id}/cancel` | Cancels the active generation and returns `204` |
| `GET` | `/v1/alerts` | Lists caller-visible alerts when Sentinel is mounted; otherwise reports `available: false` |
| `POST` | `/v1/alerts/{id}/ack` | Acknowledges a caller-visible alert and audits the outcome; `DATA_UNAVAILABLE` when Sentinel is not mounted |
| `GET` | `/healthz`, `/readyz` | Liveness and dependency readiness |

## Caller envelope

Stage 1 accepts HMAC-SHA256 envelopes: `X-Nilm-Tenant-Id`, `X-Nilm-User-Ref`, `X-Nilm-Request-Id`, `X-Nilm-Timestamp`, `X-Nilm-Nonce`, optional `X-Nilm-Allowed-Scope`, and `X-Nilm-Signature`. The canonical string covers method, path, body digest, and every context header. Endpoints accept no query parameters, and a request carrying one is rejected instead of partially signing it. A `tenant_id` in the JSON body is ignored and audited; Tools never receive it.

## SSE replay

`POST /v1/turns` never returns the event stream directly. The caller connects to `streamUrl`, so reconnect, cancellation, idempotency, and audit all anchor on a stable `turnId`. The per-turn buffer keeps events in process memory; `Last-Event-ID` replays events newer than the client checkpoint and a `ping` frame keeps idle connections alive.

## PVC state and shard ownership

With `sessionsRoot` set, every new Session of a tenant uses `<sessionsRoot>/<encoded tenant>` as its working directory, and the conversation index lives under `<sessionsRoot>/<encoded tenant>/.nilm/conversations/`. A replacement Pod on the same PVC reloads that index, resumes the JSONL Session, and returns persisted history; the JSONL backend ignores a torn crash tail on read and truncates it before the first append. `shardIndex` and `shardCount` reject a verified tenant owned by another shard with `403 SCOPE_FORBIDDEN` before any conversation state is touched, so an edge-routing mistake cannot write a tenant onto the wrong volume.

## Load testing

`pnpm test:perf:load` drives the G4-3 workload. A target run signs every request per tenant and exercises 100 tenants with five concurrent sessions for 30 minutes after a 60-second warm-up. The defaults are a target-run contract, not a smoke test: `--duration 30m`, `--warmup 60s`, `--tenants 100`, `--sessions 5`, a 30% tool-prompt share split evenly between single-tool queries and multi-tool analysis, and a 30-second turn deadline. `--help` lists every override.

A target run refuses to start without `--target`, `--manifest`, and `--output`, and without `NILM_LOAD_SIGNING_SECRETS` naming a JSON file that maps each tenant id to its signing secret. The script also accepts the JSON object inline. Secrets must match the deployment and must never enter the repository or the report.

```sh
NILM_LOAD_SIGNING_SECRETS=/secure/load-secrets.json \
pnpm test:perf:load \
  --target https://nilm.example.com \
  --manifest load-dataset.json \
  --tenants-file tenants.json \
  --output g4-3-report.json
```

The manifest declares the dataset the run is allowed to exercise. A short or malformed declaration is rejected before any traffic:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-19T00:00:00.000Z",
  "tenants": 100,
  "minuteDays": 90,
  "secondDays": 7,
  "meteringPointsPerTenant": 5,
  "tenantIds": ["tenant-000", "tenant-001"]
}
```

`tenants` must cover the requested tenant count, `minuteDays` must be at least 90, `secondDays` at least 7, and `meteringPointsPerTenant` at least 5. When `--tenants-file` supplies the exercised ids, `tenantIds` must declare every one of them; the validated manifest is copied into the report. Archive the report with the manifest, tenant list, exact command, and timestamps, because the report is the only durable output.

The report measures these observations:

| Observation | Pass condition |
| :--- | :--- |
| First stream event p95 | `< 300 ms` from `POST /v1/turns` start to the first non-`ping` SSE frame; turn acceptance is included |
| No-tool first token p95 | `< 1.5 s` from turn start to the first `text.delta` or `text.done` on a completed turn with no observed tool |
| Tool end-to-end p95 / p99 | `< 8 s` / `< 12 s` from turn start to `done` on turns that emitted `tool.start` |
| HTTP 5xx rate | `< 0.5%` of every request the harness made |
| Turn error rate | `< 0.5%` of measured turns; completed turns ended with `done` and no error frame |
| Transport failures | `0` |
| Tenant isolation | `0` leaks; each declared tenant receives message-read and conversation-list probes |
| Load shape and window | at least 100 tenants x 5 sessions and at least 30 measured minutes |
| Prompt scenario coverage | at least 20 measured turns each for no-tool, single-tool, and multi-tool prompts |

Tool turns are classified only by an observed `tool.start`; a prompt that asks for analysis but produces no tool call is not counted as a tool sample. The report also counts observed tool calls, so an operator can distinguish "tool prompts produced no tool call" from "the target was never asked to use a tool". Every latency and scenario gate needs at least 20 samples; fewer samples report `insufficient` or `fail`, never a pass. The process exits `0` only when every gate passes, `1` when a gate fails, and `2` for usage or configuration errors.

The isolation phase runs after the measurement window. Another tenant reads each victim conversation and lists its own conversations; the read must return `401`, `403`, or `404`, and the list must not contain the victim conversation id.

`pnpm test:perf:load --self-check --output /tmp/perf-self-check.json` starts the real BFF against an in-memory conversation store and a synthetic agent. It exercises signing, HTTP, SSE, turn scheduling, and isolation probes without a model, database, or cluster. Its report is labeled `self-check`, omits G4-3 gates, and its `evidence` field states that it is not G4-3 evidence. A self-check cannot substitute for a target report.

## Security testing

`pnpm test:security:pentest` runs the versioned `4.4.1` attack corpus. Its 32 cases exercise four layers: forged or replayed BFF envelopes and cross-tenant reads, the SELECT-only SQL guard, model-supplied tool arguments whose undeclared authority fields are rejected as `INVALID_ARGS`, and the immutable `CallContext`.

An authentication failure emits `auth.rejected`. Every other refusal emits `request.rejected`, carrying the verified tenant only when identity verification already succeeded. A tool failure carrying `INVALID_ARGS`, `SCOPE_FORBIDDEN`, or an unavailable tenant context emits `tool.rejected`; the SQL guard emits `sql.rejected` before a driver sees the statement. Audit records never contain request bodies, model prompts, phone numbers, OpenID values, signatures, or tokens. Plugin log messages pass through `redactText`, and structured audit values through `redactValue`, masking mainland mobile numbers as `138****0000`, labeled or raw OpenID values, bearer credentials, API keys, and `v1=` signatures. The suite asserts that every declared case ran, so deleting or renaming a case fails it.

Offline evidence ends at interception and audit emission. It does not prove production log retention, KMS-backed database encryption, or provider-side model handling. Sessions intentionally retain the model-visible user request, so G4-4 cannot be met by asserting that the raw question is absent; the production review must show Session access control and encryption, an audited log sink, and a `nilm_security_audit` store. G4-4 still requires that review and a no-Critical/no-High finding.

## Known Limitations and Deferred Work

- mTLS is not implemented in stage 1; only HMAC envelopes are accepted. Production onboarding still needs the mTLS path required by the high-level design.
- The nonce cache, idempotency map, and turn buffers remain process-local. A restart loses in-flight SSE buffers and `clientMessageId` deduplication; Redis nonces and a shared idempotency record are still required before multiple simultaneously serving replicas per tenant.
- Conversation metadata is durable only when `sessionsRoot` is configured. Without it the BFF keeps the stage-1 process-local index. The MySQL `nilm_conversation` table is not wired; the PVC index is the current restart path.
- Shard count changes and tenant migration are deployment operations. The BFF refuses a tenant on a non-owning shard but never migrates Session files, and cross-shard drift recovery is not promised.
- Offline tests cover tenant directory layout, conversation reload, torn-tail reads, and Session write exclusion. A real StatefulSet SIGKILL and PVC reattach still require a cluster rehearsal.
- Turn buffers and idempotency entries are retained for the process lifetime; stage 1 has no eviction or archival policy for them.
- Audit records reach the plugin logger with in-process masking; `nilm_security_audit` persistence and production log-sink retention evidence are still pending.
- Alert listing and acknowledgement delegate to `nilmSentinel`; they remain unavailable by design when that plugin is not mounted. Pagination is not exposed until the signed-request contract accepts query parameters.
- The G4-3 harness has offline tests only. No 100-tenant x 5-session, 30-minute target report has been produced; a self-check validates the harness, not service capacity.
- The G4-4 attack corpus is offline. Production log review, KMS/AES-GCM verification, audit-store retention, and a no-Critical/no-High security finding remain outstanding.
