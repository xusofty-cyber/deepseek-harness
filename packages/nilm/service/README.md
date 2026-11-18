# `@deepseek-ai/dsh-nilm-service`

English | [中文](README.zh.md)

Backend BFF for the standalone NILM agent. It verifies caller envelopes, owns conversation and turn records, drives the mounted Agent through `ctx.agents`, and publishes REST plus SSE values to the caller's application or mini-program backend. It provides no login, registration, role, menu, WeChat binding, admin console, or customer-facing Web UI; the caller authenticates its own users and injects an immutable `CallContext`.

## Configuration

All deployment values come from the profile patch or `NILM_*` environment variables: bind host and port, session working directory, model provider and ids, per-tenant HMAC secrets, clock skew, nonce TTL, turn timeout, ping interval, and body limit. The package compiles no database address, secret, or model id.

## Endpoints

| Method | Path | Behavior |
| :--- | :--- | :--- |
| `POST` | `/v1/conversations` | Creates a server-issued `conversationId` |
| `GET` | `/v1/conversations` | Lists the caller's conversations, newest first |
| `GET` | `/v1/conversations/{id}/messages` | Returns the caller-visible user and assistant history |
| `POST` | `/v1/turns` | Accepts one message and returns `202` with `turnId`, `sessionId`, `conversationId`, and `streamUrl`; repeats of `clientMessageId` return the same turn |
| `GET` | `/v1/turns/{id}/stream` | SSE stream with monotonic ids, `Last-Event-ID` replay, and keepalive `ping` |
| `POST` | `/v1/turns/{id}/cancel` | Cancels the active generation and returns `204` |
| `GET` | `/v1/alerts` | Stage-1 skeleton that reports an empty, unavailable store |
| `POST` | `/v1/alerts/{id}/ack` | Returns `DATA_UNAVAILABLE` until the Sentinel store exists |
| `GET` | `/healthz`, `/readyz` | Liveness and dependency readiness |

## Caller envelope

Stage 1 accepts HMAC-SHA256 envelopes: `X-Nilm-Tenant-Id`, `X-Nilm-User-Ref`, `X-Nilm-Request-Id`, `X-Nilm-Timestamp`, `X-Nilm-Nonce`, optional `X-Nilm-Allowed-Scope`, and `X-Nilm-Signature`. The canonical string covers method, path, body digest, and every context header. Endpoints accept no query parameters, and a request carrying one is rejected instead of partially signing it. A `tenant_id` in the JSON body is ignored and audited; Tools never receive it.

## SSE replay

`POST /v1/turns` never returns the event stream directly. The caller connects to `streamUrl`, so reconnect, cancellation, idempotency, and audit all anchor on a stable `turnId`. The per-turn buffer keeps events in process memory; `Last-Event-ID` replays events newer than the client checkpoint and a `ping` frame keeps idle connections alive.

## Known Limitations and Deferred Work

- mTLS is not implemented in stage 1; only HMAC envelopes are accepted. Production onboarding still needs the mTLS path required by the high-level design.
- The nonce cache, conversation metadata, idempotency map, and turn buffers are process-local. A restart loses conversation listing and ownership mapping, and a second replica cannot replay or deduplicate another replica's work. Redis nonces and `nilm_conversation` persistence are required before multi-replica deployment.
- Turn buffers and idempotency entries are retained for the process lifetime; stage 1 has no eviction or archival policy for them.
- Security audit currently goes to the plugin logger as structured text; `nilm_security_audit` persistence arrives with the audit-store integration.
- Alert routes are read-only skeletons. Real alert listing and acknowledgement wait for the stage-3 Sentinel store.
