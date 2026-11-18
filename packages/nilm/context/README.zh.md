# `@deepseek-ai/dsh-nilm-context`

[English](README.md) | 中文

将每个运行时 Agent 绑定到 BFF 验证过的不可变调用方上下文。绑定只存在于进程内存，并有意不写入 Tool 参数或 Session JSONL。

## 配置

无。该服务没有 schema，也没有持久状态。

## 扩展点

`bind(agentId, callContext)` 注册冻结的上下文并返回精确绑定的 disposer；`require(agentId)` 读取它；`revoke(agentId)` 移除它。重新绑定会替换先前的值，旧 disposer 永远不会移除替换后的值。

## 已知限制与延期工作

- 调用方签名验证属于阶段 1 的 BFF。本包信任收到的 `CallContext`，只强制身份字段非空与不可变性。
