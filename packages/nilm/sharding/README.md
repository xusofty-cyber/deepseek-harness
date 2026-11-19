# `@deepseek-ai/dsh-nilm-sharding`

English | [中文](README.zh.md)

Maps an authenticated tenant id to one NILM StatefulSet shard. The mapping is MurmurHash3 x86-32 over the UTF-8 tenant id, reduced modulo the configured shard count. The edge gateway and the serving Pod use the same function, so a Pod can refuse a tenant that belongs to another PVC instead of corrupting a Session log.

## Routing contract

`shardForTenant(tenantId, shardCount)` is stable for one tenant and one shard count. `resolveShardAssignment(index, count)` validates one Pod's membership and defaults to the single-shard deployment. `shardPodName(prefix, index)` returns the StatefulSet ordinal name, for example `nilm-agent-3`.

The function is a modulo hash, not a ring. Adding or removing a shard remaps a subset of tenants, so a count change requires a drain, archive, and tenant migration window; this package never moves Session data and never opens two writers for one tenant.

## Known Limitations and Deferred Work

- The package is a pure routing contract. It does not run an HTTP proxy, watch Kubernetes endpoints, or move PVC data; the deployment manifests and edge gateway own those steps.
- Changing the shard count without migration leaves some tenants mapped to a Pod whose PVC does not hold their Session. `nilm-service` rejects such a tenant with `SCOPE_FORBIDDEN` and writes an audit record rather than falling back to another shard.
- Cross-shard drift recovery is out of scope. A tenant must be migrated while its old Pod is drained; the design does not promise online dual writers.
