# AI 基金分析（DeepSeek）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 单只基金的 AI 分析弹窗：DeepSeek `deepseek-v4-flash` + function calling（模型自主调用应用行情接口）+ 流式输出 + 按基金持久化的多轮对话。

**Architecture:** 纯前端。新增 `app/lib/deepseek.js`（SSE 流式 + tool 循环 + prompt）与 `app/components/AiAnalysisModal.jsx`（聊天 UI），按项目 modal 规范接入 `modalStore`/`ModalsLayer`，三处入口按钮。API key 与对话记录存 localStorage（经 `storageStore`，key 不在 SYNC_KEYS 内，天然不上云）。

**Tech Stack:** 原生 fetch（SSE）、Zustand（现有 store）、lucide-react `Sparkles` 图标、shadcn Dialog（沿用 SettingsModal 写法）。无新增依赖。

**验证方式:** 项目无测试框架（CLAUDE.md 确认），每个任务后跑 `npm run lint`，最后在 dev server 手工全流程验证。

**关键规范（来自 AGENTS.md，违反会被 lint/review 打回）:**

- 类型判断用 lodash（`isArray`/`isString`/`isFunction`…），禁止原生 `typeof`/`Array.isArray`（全局对象检测 `typeof window === 'undefined'` 除外）
- localStorage 读写必须走 `storageStore`
- 输入框 font-size 用 `text-[16PX]`（大写 PX）防 Safari 缩放
- modal 状态进 `modalStore.js`，渲染进 `ModalsLayer.jsx`，page.jsx 不订阅

---

### Task 1: DeepSeek 客户端 `app/lib/deepseek.js`

**Files:**

- Create: `app/lib/deepseek.js`

- [ ] **Step 1: 创建文件，写入完整实现**

```javascript
'use client';

import { isArray, isFunction, isString } from 'lodash';
import { storageStore } from '@/app/stores';
import {
  fetchFundData,
  fetchFundHistory,
  fetchFundHoldings,
  fetchFundPeriodReturns,
  fetchMarketIndices,
  searchFunds
} from '@/app/api/fund';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const MAX_TOOL_ROUNDS = 8;
const MAX_HISTORY = 50;
const MAX_TOOL_RESULT_CHARS = 8000;

// ---------- API key ----------
export const getDeepseekApiKey = () => {
  const v = storageStore.getItem('deepseekApiKey', '');
  return isString(v) ? v.trim() : '';
};

export const setDeepseekApiKey = (key) => {
  storageStore.setItem('deepseekApiKey', String(key || '').trim());
};

// ---------- 对话记录（按基金，localStorage，不参与云端同步） ----------
const chatStorageKey = (code) => `aiChat_${code}`;

export const getAiChatHistory = (code) => {
  const v = storageStore.getItem(chatStorageKey(code), []);
  return isArray(v) ? v : [];
};

export const saveAiChatHistory = (code, messages) => {
  const list = isArray(messages) ? messages.slice(-MAX_HISTORY) : [];
  storageStore.setItem(chatStorageKey(code), JSON.stringify(list));
};

export const clearAiChatHistory = (code) => {
  storageStore.removeItem(chatStorageKey(code));
};

// ---------- 工具定义（OpenAI 兼容 schema） ----------
export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'search_funds',
      description: '按基金名称或代码模糊搜索基金，用于寻找同类基金做对比',
      parameters: {
        type: 'object',
        properties: { keyword: { type: 'string', description: '基金名称关键词或 6 位代码' } },
        required: ['keyword']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_fund_realtime',
      description: '查询指定基金的实时估值、最新净值、估算涨跌幅',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: '6 位基金代码' } },
        required: ['code']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_fund_holdings',
      description: '查询指定基金的前 10 大重仓股（名称、占比、今日涨跌幅）',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: '6 位基金代码' } },
        required: ['code']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_fund_period_returns',
      description: '查询指定基金近 1 周/1 月/3 月/6 月/1 年阶段收益率（百分比）',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: '6 位基金代码' } },
        required: ['code']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_fund_history',
      description: '查询指定基金的历史单位净值走势',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '6 位基金代码' },
          range: { type: 'string', enum: ['1m', '3m', '6m', '1y', '3y'], description: '时间范围，默认 3m' }
        },
        required: ['code']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_market_indices',
      description: '查询大盘主要指数（上证、深证、创业板、恒生、纳指等）实时行情',
      parameters: { type: 'object', properties: {} }
    }
  }
];

const TOOL_IMPL = {
  search_funds: (args) => searchFunds(args?.keyword),
  get_fund_realtime: (args) => fetchFundData(args?.code),
  get_fund_holdings: (args) => fetchFundHoldings(args?.code),
  get_fund_period_returns: (args) => fetchFundPeriodReturns(args?.code),
  get_fund_history: (args) => fetchFundHistory(args?.code, args?.range || '3m'),
  get_market_indices: () => fetchMarketIndices()
};

/** 执行工具；失败时返回 { error } 供模型降级处理，绝不 throw */
const runTool = async (name, args) => {
  const fn = TOOL_IMPL[name];
  if (!isFunction(fn)) return { error: `未知工具: ${name}` };
  try {
    return await fn(args || {});
  } catch (e) {
    return { error: String(e?.message || e) };
  }
};

/** 工具结果转字符串并截断，防止撑爆上下文 */
const stringifyToolResult = (result) => {
  let s = '';
  try {
    s = JSON.stringify(result);
  } catch (e) {
    s = String(result);
  }
  return s.length > MAX_TOOL_RESULT_CHARS ? `${s.slice(0, MAX_TOOL_RESULT_CHARS)}…(已截断)` : s;
};

// ---------- Prompt ----------
export const SYSTEM_PROMPT = `你是一位有十年公募基金研究经验的投资顾问，风格克制、数据驱动，不吹不黑。

你可以调用工具查询实时行情：需要同类基金对比时用 search_funds + get_fund_realtime / get_fund_period_returns；需要大盘环境佐证时用 get_market_indices；需要看趋势时用 get_fund_history。查询要有目的，通常 2~4 次工具调用足够，不要漫无目的地查。

输出规则：
- 纯文本，禁止使用任何 markdown 符号（# * - \` 等），用中文序号和空行分段
- 首轮完整分析必须按以下四段输出，每段以【】标题开头：
【估值位置判断】当前点位处于近一年什么水平，今日波动的主要归因（重仓股/板块/大盘）
【持仓诊断】用户成本 vs 现价、浮盈浮亏评估；用户无持仓时改为分析当前是否适合建仓
【操作建议】必须明确给出「加仓/持有/减仓/分批止盈/观望」之一，附具体幅度（如"可加仓不超过现有份额的 20%"）与触发条件（如"若再跌 3% 可二次补仓"）
【风险提示】最主要的 1~2 个风险点
- 后续追问按问题直接回答，不必重复四段结构
- 建议要有可执行的具体数字，禁止"仅供参考请自行判断"式的空话
- 每次回答结尾固定一行：以上分析由 AI 生成，仅供参考，不构成投资建议。`;

/** 组装首轮 user message：注入当前基金数据 + 用户持仓 */
export const buildFirstUserMessage = (fund, holding) => {
  const f = fund || {};
  const lines = [
    `请分析以下基金（今天是 ${new Date().toLocaleDateString('zh-CN')}）：`,
    `基金：${f.name || '未知'}（${f.code || '未知'}）`,
    `最新单位净值：${f.dwjz ?? '未知'}（${f.jzrq ?? '未知'}）`,
    `实时估算净值：${f.gsz ?? '暂无'}，估算涨跌幅：${f.gszzl != null ? `${f.gszzl}%` : '暂无'}（${f.gztime || ''}）`
  ];
  const share = Number(holding?.share);
  const cost = Number(holding?.cost);
  if (Number.isFinite(share) && share > 0 && Number.isFinite(cost) && cost > 0) {
    const nav = Number(f.gsz ?? f.dwjz);
    const profitPct = Number.isFinite(nav) && nav > 0 ? (((nav - cost) / cost) * 100).toFixed(2) : null;
    lines.push(
      `我的持仓：${share} 份，成本价 ${cost}，持有金额约 ${Number.isFinite(nav) ? (share * nav).toFixed(2) : '未知'} 元${
        profitPct != null ? `，浮动收益率约 ${profitPct}%` : ''
      }`
    );
  } else {
    lines.push('我的持仓：暂无（尚未买入）');
  }
  lines.push('请先用工具查询必要数据（重仓股、阶段收益、大盘环境等），再按规定格式输出分析。');
  return lines.join('\n');
};

// ---------- 消息清洗：去掉本地展示用字段后再发给 API ----------
const toApiMessage = (m) => {
  const out = { role: m.role, content: m.content ?? '' };
  if (m.tool_calls) out.tool_calls = m.tool_calls;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  return out;
};

// ---------- SSE 流式对话 + tool calling 循环 ----------
/**
 * 异步生成器。yield 事件：
 *   { type: 'delta', text }          — 增量正文
 *   { type: 'tool', name }           — 正在执行某个工具
 *   { type: 'done', messages }       — 完成，messages 为包含新增 assistant/tool 消息的完整数组
 * 抛出 Error（携带 .status）：401 key 无效 / 402 余额不足 / 429 限流 / 其他
 */
export async function* chatWithTools({ apiKey, messages, signal }) {
  const workMessages = messages.map(toApiMessage);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: workMessages,
        tools: TOOL_DEFS,
        stream: true
      })
    });

    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = j?.error?.message || '';
      } catch (e) {
        // ignore
      }
      const friendly =
        res.status === 401
          ? 'API Key 无效，请到设置中检查'
          : res.status === 402
            ? 'DeepSeek 账户余额不足'
            : res.status === 429
              ? '请求过于频繁，请稍后再试'
              : `请求失败（${res.status}）`;
      const err = new Error(detail ? `${friendly}：${detail}` : friendly);
      err.status = res.status;
      throw err;
    }

    // ---- 解析 SSE 流 ----
    let content = '';
    const toolCalls = [];
    let finishReason = null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const sseLines = buf.split('\n');
      buf = sseLines.pop();
      for (const line of sseLines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let chunk = null;
        try {
          chunk = JSON.parse(payload);
        } catch (e) {
          continue;
        }
        const choice = chunk?.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta || {};
        if (isString(delta.content) && delta.content) {
          content += delta.content;
          yield { type: 'delta', text: delta.content };
        }
        if (isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!toolCalls[i]) {
              toolCalls[i] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
            }
            if (tc.id) toolCalls[i].id = tc.id;
            if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
          }
        }
      }
    }

    if (finishReason === 'tool_calls' && toolCalls.length > 0) {
      workMessages.push({ role: 'assistant', content, tool_calls: toolCalls });
      for (const tc of toolCalls) {
        const name = tc.function?.name || '';
        yield { type: 'tool', name };
        let args = {};
        try {
          args = JSON.parse(tc.function?.arguments || '{}');
        } catch (e) {
          // 参数解析失败按空参执行，runTool 内部兜底
        }
        const result = await runTool(name, args);
        workMessages.push({ role: 'tool', tool_call_id: tc.id, content: stringifyToolResult(result) });
      }
      continue; // 带工具结果进入下一轮
    }

    // 正常结束
    workMessages.push({ role: 'assistant', content });
    yield { type: 'done', messages: workMessages };
    return;
  }

  // 超过工具轮次上限
  workMessages.push({ role: 'assistant', content: '（分析中断：工具调用次数超限，请重试或换个问法）' });
  yield { type: 'done', messages: workMessages };
}
```

- [ ] **Step 2: 确认 `@/app/stores` 导出 `storageStore`**

Run: `grep -n "storageStore" app/stores/index.js`
Expected: 有 export（`app/api/fund.js` 已用 `storageStore.getItem`，必然已导出）。若实际 import 路径不同（如 `./storageStore`），按 `app/api/fund.js` 顶部的 import 写法对齐。

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: 无新增错误。

- [ ] **Step 4: Commit**

```bash
git add app/lib/deepseek.js
git commit -m "feat: add DeepSeek client with tool calling and chat persistence"
```

---

### Task 2: 聊天弹窗组件 `app/components/AiAnalysisModal.jsx`

**Files:**

- Create: `app/components/AiAnalysisModal.jsx`

- [ ] **Step 1: 创建组件**

```jsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { isArray } from 'lodash';
import { Sparkles, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useModalStore } from '../stores';
import { useStorageStore } from '../stores';
import {
  buildFirstUserMessage,
  chatWithTools,
  clearAiChatHistory,
  getAiChatHistory,
  getDeepseekApiKey,
  saveAiChatHistory,
  SYSTEM_PROMPT
} from '@/app/lib/deepseek';

const TOOL_LABELS = {
  search_funds: '搜索基金',
  get_fund_realtime: '查询实时估值',
  get_fund_holdings: '查询重仓股',
  get_fund_period_returns: '查询阶段收益',
  get_fund_history: '查询历史净值',
  get_market_indices: '查询大盘指数'
};

/**
 * AI 基金分析弹窗：流式聊天 + 按基金持久化历史。
 * messages 使用 DeepSeek API 消息结构原样存储；
 * 展示时过滤 system/tool 消息，首条自动 user 消息渲染为提示条。
 */
export default function AiAnalysisModal({ fund, onClose }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [toolLabel, setToolLabel] = useState('');
  const [error, setError] = useState('');
  const abortRef = useRef(null);
  const listRef = useRef(null);
  const startedRef = useRef(false);

  const apiKey = getDeepseekApiKey();
  const code = fund?.code;

  // 打开时恢复历史；无历史且有 key 则自动发起首轮分析
  useEffect(() => {
    if (!code || startedRef.current) return;
    startedRef.current = true;
    const history = getAiChatHistory(code);
    if (history.length > 0) {
      setMessages(history);
    } else if (apiKey) {
      const holding = useStorageStore.getState().holdings?.[code];
      const first = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildFirstUserMessage(fund, holding), _auto: true }
      ];
      setMessages(first);
      run(first);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // 卸载时中断请求
  useEffect(() => () => abortRef.current?.abort?.(), []);

  // 滚动到底部
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, streamText, toolLabel]);

  /** 驱动一轮对话（含工具循环），完成后持久化 */
  const run = async (baseMessages) => {
    setStreaming(true);
    setStreamText('');
    setToolLabel('');
    setError('');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      let acc = '';
      for await (const ev of chatWithTools({ apiKey, messages: baseMessages, signal: controller.signal })) {
        if (ev.type === 'delta') {
          acc += ev.text;
          setStreamText(acc);
          setToolLabel('');
        } else if (ev.type === 'tool') {
          setToolLabel(TOOL_LABELS[ev.name] || ev.name);
        } else if (ev.type === 'done') {
          // 保留首条 user 消息上的 _auto 标记（chatWithTools 会剥掉展示字段）
          const finalMessages = ev.messages.map((m, i) => (baseMessages[i]?._auto ? { ...m, _auto: true } : m));
          setMessages(finalMessages);
          saveAiChatHistory(code, finalMessages);
        }
      }
    } catch (e) {
      if (e?.name !== 'AbortError') setError(String(e?.message || e));
    } finally {
      setStreaming(false);
      setStreamText('');
      setToolLabel('');
      abortRef.current = null;
    }
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    const next = [...messages, { role: 'user', content: text }];
    setMessages(next);
    run(next);
  };

  const handleClear = () => {
    abortRef.current?.abort?.();
    clearAiChatHistory(code);
    setMessages([]);
    setError('');
    startedRef.current = false;
    // 触发重新自动分析
    setTimeout(() => {
      if (apiKey) {
        const holding = useStorageStore.getState().holdings?.[code];
        const first = [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildFirstUserMessage(fund, holding), _auto: true }
        ];
        startedRef.current = true;
        setMessages(first);
        run(first);
      }
    }, 0);
  };

  const goSettings = () => {
    onClose?.();
    useModalStore.setState({ settingsOpen: true });
  };

  const displayMessages = (isArray(messages) ? messages : []).filter(
    (m) => m.role === 'assistant' || m.role === 'user'
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose?.();
      }}
    >
      <DialogContent overlayClassName="modal-overlay z-[9999]" className="!p-0 z-[10000]" showCloseButton={false}>
        <div className="glass card modal" style={{ display: 'flex', flexDirection: 'column', maxHeight: '80vh' }}>
          <div className="title" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={20} style={{ color: 'var(--primary)' }} />
            <DialogTitle asChild>
              <span>
                AI 分析 · {fund?.name}（{code}）
              </span>
            </DialogTitle>
            <button
              type="button"
              className="icon-button"
              title="清空对话并重新分析"
              onClick={handleClear}
              style={{ marginLeft: 'auto', width: 28, height: 28, border: 'none', background: 'transparent' }}
            >
              <Trash2 size={14} />
            </button>
          </div>

          {!apiKey ? (
            <div style={{ padding: '24px 0', textAlign: 'center' }}>
              <div className="muted" style={{ marginBottom: 16 }}>
                尚未配置 DeepSeek API Key，请先到设置中填写。
                <br />
                Key 可在 platform.deepseek.com 申请，仅保存在本机浏览器。
              </div>
              <button type="button" className="button" onClick={goSettings}>
                去设置
              </button>
            </div>
          ) : (
            <>
              <div
                ref={listRef}
                className="scrollbar-y-styled"
                style={{ flex: 1, overflowY: 'auto', minHeight: 200, padding: '4px 2px' }}
              >
                {displayMessages.map((m, i) =>
                  m._auto ? (
                    <div
                      key={i}
                      className="muted"
                      style={{ fontSize: '0.75rem', textAlign: 'center', margin: '8px 0' }}
                    >
                      已提交基金数据与持仓信息，发起分析
                    </div>
                  ) : (
                    <div
                      key={i}
                      style={{
                        margin: '8px 0',
                        display: 'flex',
                        justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start'
                      }}
                    >
                      <div
                        style={{
                          maxWidth: '92%',
                          padding: '8px 12px',
                          borderRadius: 10,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          fontSize: '0.85rem',
                          lineHeight: 1.6,
                          background: m.role === 'user' ? 'var(--primary)' : 'var(--chip-bg, rgba(127,127,127,0.12))',
                          color: m.role === 'user' ? '#fff' : 'inherit'
                        }}
                      >
                        {m.content}
                      </div>
                    </div>
                  )
                )}
                {streaming && (
                  <div style={{ margin: '8px 0' }}>
                    {toolLabel && (
                      <div className="muted" style={{ fontSize: '0.75rem', marginBottom: 4 }}>
                        正在{toolLabel}…
                      </div>
                    )}
                    {streamText ? (
                      <div
                        style={{
                          maxWidth: '92%',
                          padding: '8px 12px',
                          borderRadius: 10,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          fontSize: '0.85rem',
                          lineHeight: 1.6,
                          background: 'var(--chip-bg, rgba(127,127,127,0.12))'
                        }}
                      >
                        {streamText}
                      </div>
                    ) : (
                      !toolLabel && (
                        <div className="muted" style={{ fontSize: '0.75rem' }}>
                          思考中…
                        </div>
                      )
                    )}
                  </div>
                )}
                {error && (
                  <div className="error-text" style={{ margin: '8px 0' }}>
                    {error}
                    <button
                      type="button"
                      className="link-button"
                      style={{ marginLeft: 8 }}
                      onClick={() => run(messages)}
                    >
                      重试
                    </button>
                  </div>
                )}
              </div>

              <div className="row" style={{ gap: 8, marginTop: 12 }}>
                <input
                  className="input text-[16PX]"
                  style={{ flex: 1 }}
                  value={input}
                  placeholder="追问，如：现在补仓合适吗？"
                  disabled={streaming}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleSend();
                  }}
                />
                <button type="button" className="button" onClick={handleSend} disabled={streaming || !input.trim()}>
                  发送
                </button>
              </div>
              <div className="muted" style={{ fontSize: '0.7rem', marginTop: 8, textAlign: 'center' }}>
                AI 生成内容仅供参考，不构成投资建议
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: 核对两处细节**

1. `useStorageStore`/`useModalStore` 的 import 路径：查看 `app/components/ModalsLayer.jsx` 顶部（`import { useModalStore } from '../stores'`），若 `useStorageStore` 不从 `../stores` 导出，改为 `import { useStorageStore } from '../stores/storageStore'`。
   Run: `grep -n 'useStorageStore' app/stores/index.js`
2. `error-text`、`link-button`、`scrollbar-y-styled` class 是否存在：
   Run: `grep -c 'error-text\|link-button\|scrollbar-y-styled' app/globals.css`
   Expected: > 0（SettingsModal/SearchBar 已在用）。若缺失换成 `muted` + 内联颜色。

- [ ] **Step 3: Lint + Commit**

Run: `npm run lint`

```bash
git add app/components/AiAnalysisModal.jsx
git commit -m "feat: add AiAnalysisModal chat component"
```

---

### Task 3: 接入 modalStore + ModalsLayer

**Files:**

- Modify: `app/stores/modalStore.js`（三处：DEFAULTS、getClosedModalState、store 初始值）
- Modify: `app/components/ModalsLayer.jsx`（懒加载 import + 订阅 + 渲染）

- [ ] **Step 1: modalStore.js 加状态**

DEFAULTS 对象（`successModal` 行后）加：

```javascript
  aiAnalysisModal: { open: false, fund: null }
```

`getClosedModalState()` 返回对象（`successModal: { ...DEFAULTS.successModal },` 行后）加：

```javascript
  aiAnalysisModal: { ...DEFAULTS.aiAnalysisModal },
```

store 初始值（`successModal: { ...DEFAULTS.successModal },` 行后，即 "Cloud/sync modals" 区块内）加：

```javascript
  aiAnalysisModal: { ...DEFAULTS.aiAnalysisModal },
```

- [ ] **Step 2: ModalsLayer.jsx 渲染**

顶部懒加载区（`const AllSectorsModal = dynamic(...)` 附近）加：

```javascript
const AiAnalysisModal = dynamic(() => import('./AiAnalysisModal'), { ssr: false });
```

订阅区（`const addHistoryModal = useModalStore((s) => s.addHistoryModal);` 附近）加：

```javascript
const aiAnalysisModal = useModalStore((s) => s.aiAnalysisModal);
```

渲染区（其它 `<AnimatePresence>` 块并列处，如 successModal 附近）加：

```jsx
{
  /* ===== Modal: AI 分析 ===== */
}
<AnimatePresence>
  {aiAnalysisModal.open && (
    <AiAnalysisModal
      fund={aiAnalysisModal.fund}
      onClose={() => _ms({ aiAnalysisModal: { open: false, fund: null } })}
    />
  )}
</AnimatePresence>;
```

注：`_ms` 是 ModalsLayer 内已有的 `useModalStore.setState` 别名，先 `grep -n '_ms\b' app/components/ModalsLayer.jsx` 确认；若命名不同按现有写法对齐。

- [ ] **Step 3: Lint + Commit**

Run: `npm run lint`

```bash
git add app/stores/modalStore.js app/components/ModalsLayer.jsx
git commit -m "feat: wire AiAnalysisModal into modal store and layer"
```

---

### Task 4: SettingsModal 加 API Key 输入

**Files:**

- Modify: `app/components/SettingsModal.jsx`

- [ ] **Step 1: 加 import 与本地 state**

顶部 import 区加：

```javascript
import { getDeepseekApiKey, setDeepseekApiKey } from '@/app/lib/deepseek';
```

state 区（`const [localContainerWidth, ...]` 附近）加：

```javascript
const [localDeepseekKey, setLocalDeepseekKey] = useState(() => getDeepseekApiKey());
```

- [ ] **Step 2: 加表单块**

「数据导出」form-group 之前插入：

```jsx
<div className="form-group" style={{ marginBottom: 16 }}>
  <div className="muted" style={{ marginBottom: 8, fontSize: '0.8rem' }}>
    DeepSeek API Key（AI 分析功能，仅保存在本机）
  </div>
  <input
    className="input text-[16PX]"
    type="password"
    autoComplete="off"
    value={localDeepseekKey}
    onChange={(e) => setLocalDeepseekKey(e.target.value)}
    placeholder="sk-..."
  />
</div>
```

- [ ] **Step 3: 保存时写入**

「保存并关闭」按钮的 onClick 中，在调用 `saveSettings(...)` 之前加一行：

```javascript
setDeepseekApiKey(localDeepseekKey);
```

即：

```jsx
onClick={(e) => {
  setDeepseekApiKey(localDeepseekKey);
  saveSettings(
    e,
    localSeconds,
    ...（原有参数不动）
  );
}}
```

- [ ] **Step 4: Lint + Commit**

Run: `npm run lint`

```bash
git add app/components/SettingsModal.jsx
git commit -m "feat: add DeepSeek API key input in settings"
```

---

### Task 5: 三处入口按钮

**Files:**

- Modify: `app/components/PcFundTable.jsx`（操作列 cell，约 2513 行删除按钮处）
- Modify: `app/components/FundCard/index.jsx`（约 570 行删除按钮 Tooltip 处）
- Modify: `app/components/MobileFundTable.jsx`（约 1843 行 `dataSourceModal` 打开处附近的操作区）

三处都用同一逻辑打开 modal。fund 对象来源：PcFundTable/MobileFundTable 的行数据可能是包装对象，统一用 `original.rawFund ?? original`；FundCard 直接是 `f`。

- [ ] **Step 1: PcFundTable 操作列加按钮**

确认 import（文件顶部已有则跳过）：

```javascript
import { Sparkles } from 'lucide-react';
import { useModalStore } from '../stores';
```

在操作列 cell 的删除按钮 `<button className="icon-button danger" ...>` 之前加：

```jsx
<button
  className="icon-button"
  title="AI 分析"
  onClick={(e) => {
    e.stopPropagation?.();
    useModalStore.setState({ aiAnalysisModal: { open: true, fund: original.rawFund ?? original } });
  }}
  style={{ width: '28px', height: '28px', opacity: 1, cursor: 'pointer' }}
>
  <Sparkles width={14} height={14} />
</button>
```

- [ ] **Step 2: FundCard 加按钮**

确认 import 后，在删除按钮的 `<Tooltip>` 之前（同一个 `row` 容器内）加：

```jsx
<Tooltip>
  <TooltipTrigger asChild>
    <button
      className="icon-button"
      onClick={() => useModalStore.setState({ aiAnalysisModal: { open: true, fund: f } })}
      style={{ width: '28px', height: '28px', opacity: 1, cursor: 'pointer' }}
    >
      <Sparkles width={14} height={14} />
    </button>
  </TooltipTrigger>
  <TooltipContent>
    <p>AI 分析</p>
  </TooltipContent>
</Tooltip>
```

- [ ] **Step 3: MobileFundTable 加按钮**

先 `grep -n 'dataSourceModal: { open: true' app/components/MobileFundTable.jsx` 定位现有操作按钮（约 1843 行），观察其所在按钮组的结构与样式，在同组内仿照相邻按钮的写法加一个：

```jsx
<button
  className="icon-button"
  title="AI 分析"
  onClick={(e) => {
    e.stopPropagation?.();
    useModalStore.setState({ aiAnalysisModal: { open: true, fund: original.rawFund ?? original } });
  }}
  style={{ width: '28px', height: '28px' }}
>
  <Sparkles width={14} height={14} />
</button>
```

（`useModalStore` 该文件已 import；变量名若非 `original` 以现场为准，与相邻按钮取同一数据源。）

- [ ] **Step 4: Lint + Commit**

Run: `npm run lint`

```bash
git add app/components/PcFundTable.jsx app/components/FundCard/index.jsx app/components/MobileFundTable.jsx
git commit -m "feat: add AI analysis entry buttons to table, card and mobile views"
```

---

### Task 6: 端到端手工验证

**Files:** 无代码改动

- [ ] **Step 1: 启动 dev server**

Run: `npm run dev`（或通过已配置的 preview 工具）

- [ ] **Step 2: 验证清单（逐项过）**

1. 无 key：点任意基金的 AI 按钮 → 弹窗提示"尚未配置 DeepSeek API Key" + "去设置"按钮 → 点击后打开设置弹窗
2. 设置中填入有效 key → 保存并关闭 → 重开 AI 弹窗 → 自动发起分析，可见"正在查询xxx…"工具指示，正文流式输出，四段结构完整，结尾有免责声明
3. 追问一条（如"现在补仓合适吗"）→ 正常流式回答
4. 关闭弹窗重新打开 → 历史恢复
5. 刷新页面重新打开 → 历史仍在（localStorage 持久化）
6. 点清空按钮 → 记录清除并自动重新分析
7. 填错误 key（如 sk-invalid）→ 显示"API Key 无效，请到设置中检查" + 重试按钮
8. 无持仓基金 → 首轮 prompt 走"暂无持仓"分支，分析输出"是否适合建仓"
9. 移动端视口（640px 以下）→ 入口按钮可见可点，弹窗可正常输入（无 Safari 缩放问题）
10. 浏览器 console 无新增报错

- [ ] **Step 3: 验证 localStorage key 不进云端同步**

登录状态下发起一次分析，检查 Supabase `user_configs` 的 payload 不包含 `aiChat_*` 与 `deepseekApiKey`（SYNC_KEYS 白名单机制保证，抽查确认即可）。

- [ ] **Step 4: 最终提交（如有验证期间的修复）**

```bash
git add -A && git commit -m "fix: AI analysis polish after e2e verification"
```

---

## Self-Review 记录

- **Spec 覆盖**：模型/自填 key/6 工具/多轮持久化/四段 prompt/错误处理/三入口/免责声明 — 各有对应任务 ✅；spec 的"QDII 估值缺失"边界由 buildFirstUserMessage 的 `?? '暂无'` 兜底 ✅
- **占位符**：无 TBD/TODO；MobileFundTable 按钮位置需现场定位属于合理的"锚点指引"而非占位 ✅
- **命名一致性**：`aiAnalysisModal`、`chatWithTools`、`getAiChatHistory` 等在各任务间一致 ✅
