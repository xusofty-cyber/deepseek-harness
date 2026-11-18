---
description: "NILM 工厂能源领域包组：为独立 agent 服务提供稳定类型、调用方上下文绑定与只读数据源适配器。"
kind: "package-group"
---

# NILM 领域包

[English](README.md) | 中文

本组承载运行在 harness 上的 NILM 工厂能源服务。它不是通用的 harness 能力组：这些包实现单个部署的领域边界，生产组合位于 [`bundle/nilm-app`](../bundle/nilm-app/README.zh.md)。

## 包

| 包 | ctx key | 职责 |
|---|---|---|
| [`core`](core/README.zh.md) | — | 品牌化标识符、范围与计量结构、数据质量元数据、`ChartSpec`、`AlertCard` 与稳定错误码 |
| [`context`](context/README.zh.md) | `nilmContext` | 从 Agent 到 BFF 验证过的调用方上下文的进程内存绑定 |
| [`source`](source/README.zh.md) | `nilmSource` | 项目 MySQL、上游 MySQL、TDengine 热数据／统计数据端点与冷数据代理的受控只读适配器 |
| [`assets`](assets/README.zh.md) | `nilmAssets` | 授权五级拓扑解析与互不重叠计量点选择 |
| [`timeseries`](timeseries/README.zh.md) | `nilmTimeseries` | 热库、预聚合、冷库、设备状态与原始分析数据路由，带结果上限与质量元数据 |
| [`tariff`](tariff/README.zh.md) | `nilmTariff` | 电价方案校验、生效方案选择与分时切片纯函数 |
| [`analytics`](analytics/README.zh.md) | `nilmAnalytics` | 电费、运行／空载、设备用量、周期对比、电能质量与 CUSUM 特征纯函数 |
| [`safety`](safety/README.zh.md) | `nilmSafety` | 授权隐患记录检索与确定性风险投影 |
| [`sentinel`](sentinel/README.zh.md) | `nilmSentinel` | 增量安全扫描、租户规则、告警生命周期与事务化 Outbox 入队 |
| [`notify`](notify/README.zh.md) | `nilmNotify` | Outbox 调度、渠道网关、重试策略与异步研判 |
| [`scheduler`](scheduler/README.zh.md) | `nilmScheduler` | 幂等晨报、月度功率因数预测与 R-08 数据质量巡检 |
| [`prompt`](prompt/README.zh.md) | — | 与租户无关的稳定系统提示词策略 |
| [`tools`](tools/README.zh.md) | — | 6 个面向模型的 `nilm_*` 工具与受限结构化事实 |
| [`service`](service/README.zh.md) | — | 后端 BFF：调用方验签、会话与本轮状态、REST 端点与 SSE 重放 |

`charts` 仍属后续工作。`nilm-service` 负责 HTTP/SSE BFF；本组不实现用户权限、管理后台或面向客户的 Web 应用。

## 已知限制与延期工作

- 阶段 1 与阶段 2 交付拓扑、时序、电价、分析、电能质量与 CUSUM 特征、安全、提示词、6 个面向模型的工具与 `nilm-service` BFF；阶段 3 增加巡检规则与 Outbox 通知器；阶段 4 增加定时报告服务。BFF 将 nonce、会话元数据与本轮缓冲保存在进程内；多副本部署仍需 Redis nonce 与 `nilm_conversation` 持久化。
- 在上游提供分相电流与完整谐波列之前，三相不平衡和完整 THD 不可用；工具返回 `null` 或逐阶可用性，不做估算。
