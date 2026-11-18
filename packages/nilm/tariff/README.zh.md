# `@deepseek-ai/dsh-nilm-tariff`

[English](README.md) | 中文

校验租户录入的分时电价方案，选择某一时刻唯一生效的方案，并把已授权时间区间切分为已定价时段和显式缺口。本包不执行 IO、不读取时钟，也不做业务时区转换；调用方提供 epoch 毫秒区间与投影后的日历日。

## 配置

本包无配置项。`SourceTariffRepository` 通过 `ctx.nilmSource` 读取 `nilm_tariff_plan`、`nilm_tariff_period` 与 `nilm_calendar_day`；`NilmTariffDependencies.repository` 可替换该读取接缝。电价与季节属于租户数据，而不是部署常量。

## 扩展点

`ctx.nilmTariff` 暴露 `effectivePlan(callContext, atMs, signal?)` 与 `splitByTariff(callContext, range, planId?, signal?)`，先读取租户生效方案与投影日历，再委托纯函数计算。导出 `parseClockMinutes`、`validateTariffPlan`、`selectEffectivePlan`、`splitRangeByTariff` 和 `tariffPeriodRank` 仍可脱离 Cordis 上下文直接使用。

方案使用左闭右开的 epoch 区间。时段以 `HH:mm` 编写且不得跨午夜；跨午夜时段拆成两段。时段重叠、同一时刻多个方案生效、负电价、日历日未排序或重叠都会以 `NilmError` 代码 `INVALID_ARGUMENT` 失败。未覆盖区间以 `outside_plan`、`missing_day` 或 `no_period` 缺口返回；相邻且电价类型、价格、方案均相同的切片会合并。

## 已知限制与延期工作

- 功率因数政策读取与奖惩公式随阶段 2 提供。部署必须核对 DATE/TIME 列语义并填充 `nilm_calendar_day.season`；本包不按月份区间推断季节。
