# `@deepseek-ai/dsh-nilm-app`

English | [中文](README.zh.md)

Standalone NILM production profile. `cordis.patch.yml` is a complete Cordis tree, not an overlay on `dsh-base`. It mounts the model, session, tool registry, Agent Loop, NILM context/source/assets/timeseries/tariff/analytics/safety services, the sentinel rule engine, the notification Outbox, the NILM prompt policy, the six model-facing `nilm_*` tools, the `nilm-service` HTTP/SSE BFF, and a startup tool-surface guard. Shell, filesystem, web, MCP, terminal, sandbox, subagent, attachment, credential, and plugin-management rows are absent.

## Configuration

All endpoints and credentials come from `NILM_*` environment variables or a deployment-owned profile patch. The repository embeds no database address, account, or password. `NILM_DEEPSEEK_API_KEY` selects the model credential; the source service reads its five endpoint families independently.

The profile is a shipped template in `@deepseek-ai/dsh-official-bundles`, so `dsh --profile nilm` initializes it from `@deepseek-ai/dsh-nilm-app`. Stage 3 also reads `NILM_SENTINEL_*`, `NILM_ALERT_TEMPLATES`, and `NILM_NOTIFY_*`; channel gateway URLs and tokens stay empty until a provider is contracted, which mounts the channel as unconfigured and dead-letters it rather than retrying.

## Stage 1 startup

The production tree mounts the BFF instead of a stdio JSON-RPC carrier. Required deployment values are the `NILM_*` source endpoints, `NILM_DEEPSEEK_API_KEY`, and `NILM_SIGNING_SECRETS` (a JSON object from tenant id to HMAC secret). The BFF listens on `NILM_SERVICE_HOST:NILM_SERVICE_PORT` and exposes `/healthz` and `/readyz`; caller traffic uses the signed REST/SSE protocol documented in [`nilm-service`](../../nilm/service/README.md).

## Known Limitations and Deferred Work

- The BFF keeps nonces, conversation metadata, and turn buffers in process memory. Multi-replica deployment needs Redis nonces and `nilm_conversation` persistence; see the service limitations.
- mTLS and `nilm_security_audit` persistence are not part of the stage-1 BFF yet.
- `mysql2` is an optional peer of `@deepseek-ai/dsh-nilm-source`; the deployment image must install a compatible version before the MySQL probe or a production query runs.
- Sentinel and notify are mounted, but the 30-second SLO, live `SKIP LOCKED` contention, and WeChat/WeCom/SMS vendor integration still require staged rehearsal with real endpoints.
