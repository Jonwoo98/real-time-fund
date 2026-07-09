# AI 基金分析（DeepSeek）设计文档

日期：2026-07-09
状态：已确认

## 目标

在基估宝中新增"AI 分析"功能：针对单只基金，调用 DeepSeek API 生成专业的投资分析与加减仓建议，支持多轮追问，对话记录本地持久化。

## 核心决策（已与用户确认）

| 决策点   | 结论                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------- |
| 分析对象 | 单只基金（不做组合诊断）                                                                        |
| API Key  | 用户自填，存 localStorage，前端直连 DeepSeek（CORS 已验证可行）                                 |
| 模型     | `deepseek-v4-flash`（2026-04-24 发布，1M 上下文，工具调用能力强，低价）                         |
| 联网搜索 | 不接外部搜索 API。改为把应用自身的行情接口封装成 function calling tools，模型可自主查询实时数据 |
| 对话记录 | 按基金存 localStorage（经 storageStore），每基金最多保留 50 条，不同步云端                      |
| 输出渲染 | 纯文本分段（prompt 约束不输出 markdown），不新增渲染依赖                                        |

## 架构

纯前端实现，无后端/Edge Function 改动。

```
用户点击 AI 按钮（表格行/卡片/移动端）
  → modalStore.open('aiAnalysis', { fund })
  → AiAnalysisModal
      ├─ 无 key：提示并引导去设置页填写
      ├─ 有 key + 无历史：自动发起首轮分析
      └─ 有 key + 有历史：恢复对话，可继续追问
  → app/lib/deepseek.js
      ├─ chatStream(): fetch SSE 流式输出
      └─ tool calling 循环：模型请求工具 → 本地执行 app/api/fund.js 对应函数 → 结果回传 → 直到模型给出最终回答
  → 对话记录写入 storageStore（key: aiChat_<fundCode>）
```

## 组件与文件改动

| 文件                                 | 类型 | 内容                                                                                                |
| ------------------------------------ | ---- | --------------------------------------------------------------------------------------------------- |
| `app/lib/deepseek.js`                | 新增 | DeepSeek 客户端：SSE 流式解析、tool calling 循环、工具定义与分发。原生 fetch，不加 SDK              |
| `app/components/AiAnalysisModal.jsx` | 新增 | 聊天式弹窗：消息列表、流式渲染、输入框、清空记录按钮、免责声明。按 AGENTS.md 的 7 步 modal 规范接入 |
| `app/stores/modalStore.js`           | 修改 | 注册 aiAnalysis modal                                                                               |
| `app/components/ModalsLayer.jsx`     | 修改 | 渲染 AiAnalysisModal                                                                                |
| `app/components/SettingsModal.jsx`   | 修改 | 新增 "DeepSeek API Key" 密码型输入框                                                                |
| `app/stores/`（storageStore 相关）   | 修改 | key 的存取 + 每基金对话记录的读写/清空/裁剪（50 条上限）                                            |
| `app/components/PcFundTable.jsx`     | 修改 | 操作列加 AI 按钮                                                                                    |
| `app/components/MobileFundTable.jsx` | 修改 | 行操作加 AI 按钮                                                                                    |
| `app/components/FundCard/index.jsx`  | 修改 | 卡片加 AI 按钮                                                                                      |

## 工具（function calling）清单

全部复用 `app/api/fund.js` 现有导出，仅做参数/返回值的薄封装：

| tool 名                   | 底层函数                       | 用途                              |
| ------------------------- | ------------------------------ | --------------------------------- |
| `search_funds`            | `searchFunds(keyword)`         | 按名称/代码搜索基金（同类对比用） |
| `get_fund_realtime`       | `fetchFundData(code)`          | 实时估值、净值、涨跌幅            |
| `get_fund_holdings`       | `fetchFundHoldings(code)`      | 前 10 重仓股及占比、今日涨跌      |
| `get_fund_period_returns` | `fetchFundPeriodReturns(code)` | 近 1 周/1 月/3 月/1 年等阶段收益  |
| `get_fund_history`        | `fetchFundHistory(code, ...)`  | 历史净值走势                      |
| `get_market_indices`      | `fetchMarketIndices()`         | 大盘/主要指数实时行情             |

工具执行失败时把错误信息作为 tool result 回传给模型（模型可降级继续分析），不中断对话。tool calling 循环上限 8 轮，防失控。

## Prompt 设计

### System Prompt 要点

- 角色：十年经验的公募基金投资顾问，数据驱动，克制专业，不吹不黑
- 明确告知可用工具及何时使用（如需同类对比、板块佐证时主动调用）
- 输出为纯文本（禁用 markdown 符号），固定四段结构：
  1. **估值位置判断** — 当前点位水平、短期波动归因
  2. **持仓诊断** — 用户成本 vs 现价、浮盈浮亏评估（无持仓则改为"适合建仓吗"）
  3. **操作建议** — 必须明确给出「加仓/持有/减仓/分批止盈/观望」之一，附具体幅度（如"不超过现有份额 20%"）与触发条件（如"再跌 3% 可二次补仓"）
  4. **风险提示** — 最主要的 1~2 个风险点
- 禁止空话套话；结尾固定一行免责声明："以上分析由 AI 生成，仅供参考，不构成投资建议。"

### 首轮 User Message 注入的数据

从页面现有 state 取，不重复请求：基金名称/代码/类型、最新净值与日期、实时估值与涨跌幅、前 10 重仓股（名称/占比/今日涨跌）、关联板块及涨跌、用户持仓（成本价、份额、持有收益率、近期交易摘要；无持仓则注明）。

### 多轮对话

后续追问直接追加到 messages 数组（DeepSeek 多轮 = 全量 messages 回传）；历史裁剪到最近 50 条后随存随取。

## 错误处理

| 场景                     | 处理                                   |
| ------------------------ | -------------------------------------- |
| 未配置 key               | modal 内提示 + "去设置"按钮            |
| 401（key 无效）          | 提示 key 无效，引导重新填写            |
| 402/429（余额不足/限流） | 透出 DeepSeek 返回的错误信息           |
| 网络中断/流中断          | 已输出内容保留，显示"生成中断，可重试" |
| 工具执行失败             | 错误作为 tool result 回传模型，不中断  |

## 测试

项目无测试框架（CLAUDE.md 确认）。验证方式：

1. `npm run lint` 通过
2. 本地 dev server 手工全流程验证：填 key → 发起分析 → 观察工具调用 → 流式输出 → 追问 → 刷新恢复历史 → 清空记录
3. 边界：无 key、错误 key、无持仓基金、QDII 基金（估值缺失场景）

## 不做（YAGNI）

- 外部网页搜索（新闻类信息）——需第三方搜索 key，第一版不做
- 对话记录云端同步——会撑爆 user_configs，后续有需求再设计
- 组合级分析——已确认只做单基金
- Markdown 渲染库——prompt 约束纯文本输出
