'use client';

import { useEffect, useRef, useState } from 'react';
import { isArray } from 'lodash';
import { Sparkles, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useModalStore, useStorageStore } from '../stores';
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

const bubbleStyle = (isUser) => ({
  maxWidth: '92%',
  padding: '8px 12px',
  borderRadius: 10,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontSize: '0.85rem',
  lineHeight: 1.6,
  background: isUser ? 'var(--primary)' : 'var(--chip-bg, rgba(127,127,127,0.12))',
  color: isUser ? '#fff' : 'inherit'
});

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
  // 递增的运行序号：中止旧流后立即开新流时，旧 run 的 catch/finally 不得覆盖新 run 的状态
  const runIdRef = useRef(0);

  const apiKey = getDeepseekApiKey();
  const code = fund?.code;

  /** 组装带 system + 首轮数据注入的初始消息组 */
  const buildInitialMessages = () => {
    const holding = useStorageStore.getState().holdings?.[code];
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildFirstUserMessage(fund, holding), _auto: true }
    ];
  };

  /** 驱动一轮对话（含工具循环），完成后持久化 */
  const run = async (baseMessages) => {
    const runId = ++runIdRef.current;
    setStreaming(true);
    setStreamText('');
    setToolLabel('');
    setError('');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      let acc = '';
      for await (const ev of chatWithTools({ apiKey, messages: baseMessages, signal: controller.signal })) {
        if (runIdRef.current !== runId) return;
        if (ev.type === 'delta') {
          acc += ev.text;
          setStreamText(acc);
          setToolLabel('');
        } else if (ev.type === 'tool') {
          setToolLabel(TOOL_LABELS[ev.name] || ev.name);
        } else if (ev.type === 'done') {
          // chatWithTools 会剥掉展示用字段，这里按位置还原首条 user 消息的 _auto 标记
          const finalMessages = ev.messages.map((m, i) => (baseMessages[i]?._auto ? { ...m, _auto: true } : m));
          setMessages(finalMessages);
          saveAiChatHistory(code, finalMessages);
          setStreamText('');
        }
      }
    } catch (e) {
      if (runIdRef.current === runId && e?.name !== 'AbortError') setError(String(e?.message || e));
    } finally {
      // 仅最新一轮 run 允许收尾，避免被 abort 的旧 run 覆盖新 run 的状态；
      // 出错时不清 streamText，保留已输出内容供用户查看（spec 要求）
      if (runIdRef.current === runId) {
        setStreaming(false);
        setToolLabel('');
        abortRef.current = null;
      }
    }
  };

  // 打开时恢复历史；无历史且有 key 则自动发起首轮分析。
  // cleanup 中重置 startedRef，保证 StrictMode 双挂载时第二次挂载能重新发起分析
  useEffect(() => {
    if (!code || startedRef.current) return undefined;
    startedRef.current = true;
    const history = getAiChatHistory(code);
    if (history.length > 0) {
      setMessages(history);
    } else if (apiKey) {
      const first = buildInitialMessages();
      setMessages(first);
      run(first);
    }
    return () => {
      abortRef.current?.abort?.();
      startedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // 滚动到底部
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, streamText, toolLabel]);

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
    setError('');
    if (apiKey) {
      const first = buildInitialMessages();
      setMessages(first);
      run(first);
    } else {
      setMessages([]);
    }
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
            <Sparkles size={20} style={{ color: 'var(--primary)', flexShrink: 0 }} />
            <DialogTitle asChild>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                AI 分析 · {fund?.name}（{code}）
              </span>
            </DialogTitle>
            <button
              type="button"
              className="icon-button"
              title="清空对话并重新分析"
              onClick={handleClear}
              style={{
                marginLeft: 'auto',
                width: 28,
                height: 28,
                border: 'none',
                background: 'transparent',
                flexShrink: 0
              }}
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
                      <div style={bubbleStyle(m.role === 'user')}>{m.content}</div>
                    </div>
                  )
                )}
                {/* streaming 中显示实时输出；出错后 streamText 保留，让用户看到已生成的部分 */}
                {(streaming || streamText) && (
                  <div style={{ margin: '8px 0' }}>
                    {toolLabel && (
                      <div className="muted" style={{ fontSize: '0.75rem', marginBottom: 4 }}>
                        正在{toolLabel}…
                      </div>
                    )}
                    {streamText ? (
                      <div style={bubbleStyle(false)}>{streamText}</div>
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
