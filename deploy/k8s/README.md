---
description: "Deploy nilm-agent as a sharded StatefulSet, create its secret, verify PVC topology, and rehearse same-shard Session recovery. The G4-2 field gate is not yet rehearsed on a real cluster."
---

# NILM agent Kubernetes deployment

English | [中文](README.zh.md)

These manifests run one `nilm-agent` Pod per tenant shard. Each Pod owns one ReadWriteOnce PVC at `/data`, and the edge gateway routes a tenant to the Pod whose PVC holds that tenant's Session log. The BFF rejects a misrouted tenant after signature verification, so a routing defect cannot write a tenant onto a foreign PVC.

## Files

| File | Purpose |
| --- | --- |
| `namespace.yaml` | Creates the `nilm` namespace. |
| `secret.example.yaml` | Placeholder Secret for signing keys, model key, and data-source credentials; never apply it unchanged. |
| `configmap.yaml` | Non-secret values, including `NILM_SHARD_COUNT`. |
| `headless-service.yaml` | Per-Pod DNS `nilm-agent-<i>.nilm-agent-headless`. |
| `edge-service.yaml` | Selectorless endpoint carrier for the platform edge gateway. |
| `statefulset.yaml` | Four shards, `OrderedReady`, one PVC template. |
| `pdb.yaml` | PodDisruptionBudget at 75% availability. |
| `networkpolicy.yaml` | Default deny plus DNS, edge ingress, and data-source egress. |
| `ingress.yaml` | TLS and `/v1` routing to the edge gateway. |

## Deploy order

```sh
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f /path/to/private/nilm-secrets.yaml
kubectl apply -f deploy/k8s/configmap.yaml
kubectl apply -f deploy/k8s/headless-service.yaml -f deploy/k8s/edge-service.yaml
kubectl apply -f deploy/k8s/statefulset.yaml
kubectl apply -f deploy/k8s/pdb.yaml -f deploy/k8s/networkpolicy.yaml
kubectl apply -f deploy/k8s/ingress.yaml
```

Build the private Secret outside the repository by copying `secret.example.yaml` and replacing every placeholder; apply that private file and never commit it. `NILM_SIGNING_SECRETS` is a JSON object keyed by tenant id and must contain at least 16 characters per value.

Before applying, replace the image tag, the ingress host and TLS secret name, and the `REPLACE_WITH_*_CIDR` placeholders in `networkpolicy.yaml`. The Pod reaches the model provider over TCP 443 and the data sources over the stated ports; anything else stays denied.

When the platform gateway runs outside the `nilm` namespace, add that namespace's selector to both `allow-edge-ingress` and the `nilm-agent` ingress rule. A `podSelector` alone matches only the policy's own namespace, so the default-deny policy otherwise blocks the gateway even though its Endpoints are bound to `nilm-edge`.

## Database accounts

Use a dedicated account for each MySQL endpoint and grant only what the code needs. The application guard rejects non-SELECT SQL on the read paths, but the account grant is the boundary that still holds if the guard is bypassed.

- Upstream business MySQL (`NILM_UPSTREAM_MYSQL_*`): `SELECT` on `nilm_unsafe_record` and `appliance_category` only. No write, DDL, or schema-wide grant.
- Project MySQL (`NILM_LOCAL_MYSQL_*`): `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on the project schema. The write transaction updates alert, notification, watermark, job, report, and audit tables. Do not grant `CREATE`, `ALTER`, `DROP`, `GRANT OPTION`, or global privileges; run `packages/nilm/source/sql/init-nilm-system.sql` with a separate migration account.
- `information_schema.tables` needs no grant; MySQL shows the rows for tables the account can access, which is what the connectivity probe checks.
- The TDengine user (`NILM_UPSTREAM_TDENGINE_USER`) should also be limited to reads on the hot and statistics databases.

```sql
-- Upstream business database: read two tables only.
CREATE USER 'nilm_upstream_ro'@'10.0.0.%' IDENTIFIED BY '<password>';
GRANT SELECT ON upstream_db.nilm_unsafe_record TO 'nilm_upstream_ro'@'10.0.0.%';
GRANT SELECT ON upstream_db.appliance_category TO 'nilm_upstream_ro'@'10.0.0.%';

-- Project database: data reads and writes, no DDL.
CREATE USER 'nilm_app'@'10.0.0.%' IDENTIFIED BY '<password>';
GRANT SELECT, INSERT, UPDATE, DELETE ON nilm_db.* TO 'nilm_app'@'10.0.0.%';
```

Replace `upstream_db`, `nilm_db`, the host pattern (the Pod egress CIDR), and the passwords. Check the result with `SHOW GRANTS FOR 'nilm_upstream_ro'@'10.0.0.%';` before writing the credentials into the private Secret.

## Shard count and PVC topology

`NILM_SHARD_COUNT` in `configmap.yaml` must equal `spec.replicas` in `statefulset.yaml`. The bundle derives `NILM_SHARD_INDEX` from the trailing ordinal of `NILM_POD_NAME`; a mismatch makes some tenants unroutable or routes them to a Pod that refuses them with `403 SCOPE_FORBIDDEN`. Replace `NILM_SOURCE_TENANT_ID` with the upstream tenant key that has a `nilm_source_tenant_map` row before applying the ConfigMap; Sentinel refuses to scan without that mapping.

Each Pod mounts its own `data` volume at `/data`, and the JSONL backend writes under `/data/sessions/<encoded tenant>`. The conversation index sits under `/data/sessions/<encoded tenant>/.nilm/conversations`. Because the volume is ReadWriteOnce, a rescheduled Pod can only start after the volume detaches from the old node.

`DSH_HOME` and `HOME` point at `/data` because the container runs with a read-only root filesystem and `dsh` rewrites the profile root at every boot. The image must ship the `dsh` installation and the `@deepseek-ai/dsh-nilm-app` bundle; profile initialization must not need a package download on first start.

Check that the cluster default StorageClass uses `WaitForFirstConsumer`:

```sh
kubectl get storageclass -o custom-columns=NAME:.metadata.name,DEFAULT:.metadata.annotations.storageclass\\.kubernetes\\.io/is-default-class,BINDING:.volumeBindingMode
```

An `Immediate` class can bind the PVC in a different zone before the Pod is scheduled and leave a rescheduled Pod pending. Either set `storageClassName` to a `WaitForFirstConsumer` class or pin the Pod to the volume's node; do not rely on recovery until this check passes.

## Tenant migration and drain

The routing function is MurmurHash3 x86-32 modulo the shard count, not a consistent-hash ring. Changing `NILM_SHARD_COUNT` or `replicas` remaps a subset of tenants, so a count change is a migration, not a rolling restart.

1. Compute the old and new shard index for every tenant offline with `shardForTenant`.
2. Stop edge traffic for tenants whose index changes; let in-flight turns finish or cancel them before the deadline.
3. Copy the tenant directory between PVCs while the old Pod is stopped; do not run two writers for one tenant.
4. Verify the copied JSONL reads back and the last persisted turn is present.
5. Roll the new shard count, then restore edge traffic.

There is no online dual-write and no cross-shard drift recovery. A tenant that lands on a PVC without its Session is refused rather than silently starting an empty conversation.

## G4-2 recovery rehearsal

The rehearsal terminates a Pod with an in-flight turn and checks that the StatefulSet recreates the same ordinal on the same PVC, that the JSONL tail is handled safely, and that the next turn continues the conversation. It is not yet rehearsed on a real cluster; the offline tests in `packages/nilm/service/tests/recovery.spec.ts` are partial evidence only.

```sh
TENANT=REPLACE_TENANT
COUNT=$(kubectl -n nilm get statefulset nilm-agent -o jsonpath='{.spec.replicas}')
SHARD=$(node -e "import('./packages/nilm/sharding/src/index.ts').then(m => console.log(m.shardForTenant(process.argv[1], Number(process.argv[2]))))" "$TENANT" "$COUNT")
POD=nilm-agent-$SHARD
kubectl -n nilm get pod "$POD" -o jsonpath='{.spec.nodeName}{"\n"}'
kubectl -n nilm get pvc "data-$POD-0" -o jsonpath='{.spec.volumeName}{"\n"}'
kubectl -n nilm delete pod "$POD" --grace-period=0 --force
kubectl -n nilm wait --for=condition=Ready "pod/$POD" --timeout=300s
kubectl -n nilm get pod "$POD" -o jsonpath='{.spec.nodeName}{"\n"}'
kubectl -n nilm get pvc "data-$POD-0" -o jsonpath='{.spec.volumeName}{"\n"}'
```

Run the shard computation from the repository root with Node 24 or newer; type stripping imports the source function directly. Record the Pod node and PVC volume name before and after. The volume name must stay the same, and the node must stay the same for a local or zonal volume. Then read the conversation history through the BFF and send one more turn; the history must include the completed events from before the kill, and the new turn must persist. A torn final JSONL line is dropped on read, so a turn that had not committed an event is expected to be absent. Repeat with a forced kill during generation, not only while idle.

## Evidence status

The manifests, shard function, tenant path encoding, conversation index, and torn-tail read path have offline tests. Real SIGKILL, PVC reattach, edge routing, and node affinity have not been rehearsed here. Do not claim G4-2 until the commands above pass on the target cluster with recorded node, volume, and history output.
