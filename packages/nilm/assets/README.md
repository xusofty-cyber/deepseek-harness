# `@deepseek-ai/dsh-nilm-assets`

English | [中文](README.zh.md)

Resolves caller-supplied factory, workshop, terminal, channel, and appliance targets against the tenant's projected asset snapshot, enforces the caller's allowed scope, and selects a non-overlapping meter set for aggregation. The service reads only `nilm_asset_snapshot` and `nilm_measurement_binding` through the guarded source adapter.

## Configuration

`SourceAssetRepository` reads the project database through `ctx.nilmSource`; no endpoint or credential is configured here. `NilmAssetsDependencies.repository` replaces that read seam for tests or an alternative projection.

## Extension points

`resolveScope` matches by identifier first, then exact path, exact name, and finally a normalized name containment fallback. Equal top-scoring matches are returned with `ambiguous: true` instead of selecting one. `getWorkshopChannels` returns the resolved meter set for one workshop, and `resolveMeterSet` returns it for a unique target.

Authorization fails closed. A missing `allowedScope` means tenant-level access; a present list restricts matches to the named roots and their descendants. A target outside the allowed scope raises `SCOPE_FORBIDDEN`, while an unknown id raises `SCOPE_NOT_FOUND`. Meter selection prefers one `terminal_total` per terminal and excludes its branches; only terminals without a total fall back to leaf `branch` bindings. `reference` meters are excluded, and appliance scopes resolve to their parent channel with an estimation warning.

## Known Limitations and Deferred Work

- Snapshot synchronization from upstream channel tables is a deployment job; this package only consumes the projected rows.
- The numeric parent/child deviation threshold and `aggregationWarning` require paired energy values and arrive with the stage-1 analytics integration; this package already returns non-overlapping meters and deterministic exclusion warnings.
