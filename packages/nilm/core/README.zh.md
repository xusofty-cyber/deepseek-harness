# `@deepseek-ai/dsh-nilm-core`

[English](README.md) | 中文

与数据库和模型无关的 NILM 标识符、范围结构、数据质量元数据、带版本的 `ChartSpec` 协议、`AlertCard`、稳定错误码，以及 Sentinel 与安全查询共用的上游隐患类型分类器 `classifyUnsafeHazard`（冲击/过载为 `critical`，不平衡/电压为 `warning`，其余返回 `undefined`）。本包不持有运行时状态，也不执行 IO。

## 配置

无。所有值都是由调用方提供的类型或纯工厂。

## 扩展点

消费方使用 `@deepseek-ai/dsh-brand` 构造品牌化标识符，并以稳定错误码抛出 `NilmError`、`NilmToolError` 或 `NilmSourceError`。图表协议由 `version: 1` 判别式定版；未来不兼容的协议新增版本，而不是原地扩展版本 1。

## 已知限制与延期工作

- 工具参数 schema 与领域校验随阶段 1 的 `nilm-tools` 提供；本包只负责共享结构与错误。
