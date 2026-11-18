# `@deepseek-ai/dsh-nilm-timeseries`

[English](README.md) | 中文

把已授权的 NILM 查询路由到热库 TDengine、日/月统计端点与冷代理。实时与电量结果都受点数上限约束、完成去重，并返回覆盖率、缺口、来源与临时数据标记。

## 配置

`TimeseriesConfig` 命名五张上游表，设置 `rawPointLimit`（默认 2000）、`chartPointLimit`（默认 500）、`hotDays`（默认 90）与冷模板标识（默认 `daily_energy`）。所有字段都通过 Cordis `Config` schema 暴露，部署可按实际 DDL 覆盖。表名与冷模板名必须是裸标识符；资产投影路径按 SQL 字符串值转义。

## 扩展点

`ctx.nilmTimeseries` 暴露 `queryRealtimePoints` 与 `queryAggregatedEnergy`。纯函数 `downsamplePoints`、`downsampleBuckets` 负责图表上限。`NilmTimeseriesDependencies.source` 可替换数据源适配器，`now` 让路由年龄测试可确定复现。

实时查询同时读取三相汇总表与原始实时表，重复 `(metric, timestamp)` 优先采用汇总行，并拒绝 `REALTIME_METRICS` 之外的指标。电量查询在带投影路径的日/月范围使用统计表，较新的细粒度范围使用原始累计电量差分，范围起点超过 `hotDays` 后走冷代理。累计值负增量按表计复位报告，且不贡献电量。覆盖率比较唯一观测时间戳或桶起点与预期数量；缺口按 `Asia/Shanghai` 业务时间输出。

## 已知限制与延期工作

- 表名与列名默认采用参考上游契约；部署必须按实际 DDL 核对，不一致时传入覆盖值。
- 统计路由当前要求已投影的通道路径并处理日/月桶；车间路径前缀聚合与冷模板响应结构仍属部署集成工作。
- 汇总实时行与汇总电量行优先于重复原始行；单相/三相混合安装需确认该优先级符合其接线语义。
