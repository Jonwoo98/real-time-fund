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
  // 裁剪可能把 assistant(tool_calls)+tool 消息组切断，开头的孤儿 tool 消息会被 API 400 拒绝
  while (list.length && list[0]?.role === 'tool') list.shift();
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

    /** 解析一行 SSE，更新 finishReason/toolCalls，返回增量正文（无则 null） */
    const parseLine = (line) => {
      const t = line.trim();
      if (!t.startsWith('data:')) return null;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') return null;
      let chunk = null;
      try {
        chunk = JSON.parse(payload);
      } catch (e) {
        return null;
      }
      const choice = chunk?.choices?.[0];
      if (!choice) return null;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
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
      return isString(delta.content) && delta.content ? delta.content : null;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const sseLines = buf.split('\n');
        buf = sseLines.pop();
        for (const line of sseLines) {
          const text = parseLine(line);
          if (text) {
            content += text;
            yield { type: 'delta', text };
          }
        }
      }
      // 流末尾无换行时，finish_reason 等可能留在残留 buf 里
      for (const line of (buf + decoder.decode()).split('\n')) {
        const text = parseLine(line);
        if (text) {
          content += text;
          yield { type: 'delta', text };
        }
      }
    } finally {
      // 消费方中途丢弃生成器时确保关闭 HTTP 流，避免模型继续生成计费
      reader.cancel().catch(() => {});
    }

    if (finishReason === 'tool_calls' && toolCalls.length > 0) {
      workMessages.push({ role: 'assistant', content, tool_calls: toolCalls });
      for (const tc of toolCalls) {
        if (!tc || !tc.id) continue; // 稀疏数组空洞 / 无 id 的残缺 tool call
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
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
