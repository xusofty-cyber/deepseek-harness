# `@deepseek-ai/dsh-nilm-source`

[English](README.md) | 中文

项目 MySQL 数据库、上游业务 MySQL 数据库、TDengine 热数据与统计数据端点，以及冷仓库代理的只读适配器。应用层强制只读 SELECT 模板、表白名单、参数绑定、单语句 SQL 与固定的冷查询超时。

## 配置

`Config` 需要 `localMysql` 与 `upstreamMysql` 端点对象，以及 `tdengineHotUrl`、`tdengineStatsUrl` 与 `coldProxyUrl`。凭据是端点字段。Bundle 从这些环境变量映射配置：`NILM_LOCAL_MYSQL_*`、`NILM_UPSTREAM_MYSQL_*`、`NILM_UPSTREAM_TDENGINE_HOT_URL`、`NILM_UPSTREAM_TDENGINE_STATS_URL`、`NILM_UPSTREAM_TDENGINE_USER`、`NILM_UPSTREAM_TDENGINE_PASSWORD` 与 `NILM_COLD_PROXY_URL`。

默认值：两个 MySQL 端口均为 3306，每个连接池 10 个连接，TDengine 请求 3 秒，冷代理请求 5 秒，完整连通性探活 1000 毫秒。

## 扩展点

`SourceDependencies` 注入每个执行器或传输层，使测试与其他部署驱动可以替换实时端点。`ctx.nilmSource` 公布带门禁的 MySQL 读取（`queryLocalReadOnly`、`queryUpstreamReadOnly`、`listLocalTables`）、内部生成的 TDengine 读取（`queryHot`、`queryStats`）、固定模板冷查询（`queryCold`）、`probe` 与 `close`。TDengine 方法只供 `nilm-timeseries` 等领域适配器使用；模型侧 Tool 永远拿不到 SQL 文本。

`mysql2` 是可选的 peer，使核心包在组合期间无需解析原生驱动即可安装；部署镜像必须在 MySQL 探活或生产查询运行前提供 `mysql2@^3.11.0`。

在设置好 `NILM_*` 环境变量后运行 `pnpm --filter @deepseek-ai/dsh-nilm-source test:connectivity`。探活分别报告每个端点，并在必需表缺失或总预算超过 `probeTimeoutMs` 时失败。每个检查都接收聚合取消信号；忽略取消的驱动仍受探活预算约束。

## 已知限制与延期工作

- 阶段 0 只公布上游 MySQL 表 `nilm_unsafe_record` 与 `appliance_category`；阶段 1 通过独立服务增加资产与时间序列适配器，而不是扩大本包的表白名单。
- `mysql2` 没有可取消的查询句柄。被取消的 MySQL 请求会停止等待并丢弃结果行，但连接池可能在后台完成该语句。
