import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDinsightSse, buildDinsightRunPayload } from '../scripts/common/dinsight.js';

test('summarizeDinsightSse extracts answer, tools, and metadata from SSE', () => {
  const raw = [
    'event: metadata',
    'data: {"run_id":"run-1","thread_id":"thread-1"}',
    '',
    'event: messages',
    'data: [{"content":[{"type":"text","text":"只回复两个字：你好"}],"type":"human"}]',
    '',
    'event: custom',
    'data: {"type":"claude_agent_sdk_system","data":{"tools":["mcp__dinsight__execute_sql","mcp__dinsight__metric_search"]}}',
    '',
    'event: messages',
    'data: {"content":[{"type":"text","text":"你好"}],"type":"ai"}'
  ].join('\n');

  const summary = summarizeDinsightSse(raw);
  assert.equal(summary.runId, 'run-1');
  assert.equal(summary.threadId, 'thread-1');
  assert.equal(summary.answer, '你好');
  assert.deepEqual(summary.tools, ['mcp__dinsight__execute_sql', 'mcp__dinsight__metric_search']);
});

test('buildDinsightRunPayload keeps the human question and default assistant', () => {
  const built = buildDinsightRunPayload('查一下今日成交', { threadId: 't-1' });
  assert.equal(built.threadId, 't-1');
  assert.equal(built.payload.assistant_id, 'odin-data-agent-claude');
  assert.equal(built.payload.input.messages[0].content[0].text, '查一下今日成交');
  assert.equal(built.payload.context.thread_id, 't-1');
});

test('summarizeDinsightSse concatenates streamed assistant chunks', () => {
  const raw = [
    'event: messages',
    'data: [{"type":"AIMessageChunk","content":"最新分区是 "}]',
    '',
    'event: messages',
    'data: [{"type":"AIMessageChunk","content":"20260910150000"}]',
    '',
    'event: messages',
    'data: [{"type":"AIMessageChunk","content":"，最近5条如下。"}]'
  ].join('\n');
  const summary = summarizeDinsightSse(raw);
  assert.equal(summary.answer, '最新分区是 20260910150000，最近5条如下。');
});

