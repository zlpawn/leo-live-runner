#!/usr/bin/env node

// Local workflow storage. No query execution, credentials, or network access.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function knowledgeDirectory(env = process.env, home = os.homedir()) {
  const configured = env.LEO_INSPECTOR_KNOWLEDGE_DIR;
  if (!configured) return path.join(home, '.shrimp', 'skills', 'live-inspector', 'knowledge');
  if (configured === '~') return home;
  if (configured.startsWith('~/')) return path.join(home, configured.slice(2));
  if (!path.isAbsolute(configured)) throw new Error('LEO_INSPECTOR_KNOWLEDGE_DIR 必须是绝对路径或 ~/ 路径');
  return path.normalize(configured);
}

function validateId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) {
    throw new Error('id 必须为 1–80 位小写字母、数字或连字符');
  }
  return id;
}

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 必须为非空文本`);
  return value.trim();
}

function textArray(value, name) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${name} 必须为文本数组`);
  }
  return [...new Set(value.map(item => item.trim()))];
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('输入必须为 JSON 对象');
  return {
    id: validateId(input.id),
    title: requiredText(input.title, 'title'),
    summary: requiredText(input.summary, 'summary'),
    services: textArray(input.services, 'services'),
    keywords: textArray(input.keywords, 'keywords'),
    parameters: textArray(input.parameters, 'parameters'),
    content: requiredText(input.content, 'content')
  };
}

function workflowPath(root, id) {
  return path.join(root, 'workflows', `${validateId(id)}.md`);
}

export function readWorkflow(root, id) {
  const file = workflowPath(root, id);
  if (!fs.lstatSync(file).isFile()) throw new Error(`流程不是普通文件: ${id}`);
  const raw = fs.readFileSync(file, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`流程格式无效: ${id}`);
  const metadata = JSON.parse(match[1]);
  const workflow = validateInput({ ...metadata, content: match[2] });
  if (workflow.id !== id || metadata.schemaVersion !== 1 || !Number.isSafeInteger(metadata.version) || metadata.version < 1
      || !Number.isFinite(Date.parse(metadata.createdAt)) || !Number.isFinite(Date.parse(metadata.updatedAt))) {
    throw new Error(`流程元数据无效: ${id}`);
  }
  return { ...workflow, schemaVersion: 1, version: metadata.version, createdAt: metadata.createdAt, updatedAt: metadata.updatedAt, file };
}

export function saveWorkflow(root, input, expectedVersion) {
  const workflow = validateInput(input);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('expected-version 必须是非负整数；新建用 0');
  const directory = path.join(root, 'workflows');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = workflowPath(root, workflow.id);
  const lock = `${file}.lock`;
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`流程正在写入或留有锁: ${workflow.id}；稍后重试，异常退出遗留锁需确认无写入进程后清理`);
    throw error;
  }
  const temporary = path.join(directory, `.${workflow.id}-${randomUUID()}.tmp`);
  try {
    let current;
    try { current = readWorkflow(root, workflow.id); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if ((current?.version ?? 0) !== expectedVersion) {
      throw new Error(`版本冲突: 当前版本 ${current?.version ?? 0}，期望 ${expectedVersion}；重新读取并合并后保存`);
    }
    const now = new Date().toISOString();
    const { content, ...fields } = workflow;
    const metadata = { schemaVersion: 1, ...fields, version: expectedVersion + 1, createdAt: current?.createdAt ?? now, updatedAt: now };
    // JSON is a YAML subset; deterministic frontmatter requires no YAML dependency.
    fs.writeFileSync(temporary, `---\n${JSON.stringify(metadata, null, 2)}\n---\n\n${content}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
    return { ...metadata, file };
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.rmdirSync(lock);
  }
}

export function searchWorkflows(root, query = '', service = '') {
  let entries;
  try { entries = fs.readdirSync(path.join(root, 'workflows'), { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return { workflows: [], warnings: [] };
    throw error;
  }
  const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  const workflows = [];
  const warnings = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    let workflow;
    try { workflow = readWorkflow(root, entry.name.slice(0, -3)); } catch {
      warnings.push(`无法读取流程文件: ${entry.name}；请检查格式，未将它视为无匹配`);
      continue;
    }
    if (service && !workflow.services.some(item => item.toLocaleLowerCase() === service.toLocaleLowerCase())) continue;
    const fields = [workflow.id, workflow.title, workflow.summary, ...workflow.services, ...workflow.keywords].join(' ').toLocaleLowerCase();
    const body = workflow.content.toLocaleLowerCase();
    if (!terms.every(term => fields.includes(term) || body.includes(term))) continue;
    const score = terms.reduce((sum, term) => sum + (fields.includes(term) ? 3 : 1), 0);
    const { content, ...summary } = workflow;
    workflows.push({ ...summary, score });
  }
  workflows.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return { workflows, warnings };
}

function printUsage() {
  console.log(`本地排查流程库（只存取文档，不执行查询）
  node scripts/knowledge.js path
  node scripts/knowledge.js list [--service <service>]
  node scripts/knowledge.js search "关键词 空格分隔" [--service <service>]
  node scripts/knowledge.js show <id>
  node scripts/knowledge.js save --file <JSON文件或-> --expected-version <版本>

新建版本为 0；更新先 show，使用返回的 version。所有结果为 JSON。
默认目录: ~/.shrimp/skills/live-inspector/knowledge/
覆盖目录: LEO_INSPECTOR_KNOWLEDGE_DIR（绝对路径）。
JSON 字段: id, title, summary, services[], keywords[], parameters[], content（Markdown）。`);
}

function takeOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数`);
  args.splice(index, 2);
  return value;
}

export function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  if (!args.length || args[0] === '--help' || args[0] === '-h') return printUsage();
  const command = args.shift();
  const root = knowledgeDirectory();
  let result;
  if (command === 'path') {
    if (args.length) throw new Error('path 不接受额外参数');
    result = { directory: root };
  } else if (command === 'list' || command === 'search') {
    const service = takeOption(args, '--service') ?? '';
    const query = command === 'search' ? requiredText(args.shift(), '关键词') : '';
    if (args.length) throw new Error('存在未知参数；多个关键词请放在同一段引号内');
    result = { directory: root, ...searchWorkflows(root, query, service) };
  } else if (command === 'show') {
    if (args.length !== 1) throw new Error('show 需要一个流程 id');
    result = readWorkflow(root, args[0]);
  } else if (command === 'save') {
    const source = takeOption(args, '--file');
    const version = takeOption(args, '--expected-version');
    if (!source || !/^\d+$/.test(version ?? '') || args.length) throw new Error('save 需要 --file 和 --expected-version；不接受其他参数');
    const input = JSON.parse(fs.readFileSync(source === '-' ? 0 : source, 'utf8'));
    result = saveWorkflow(root, input, Number(version));
  } else {
    throw new Error(`未知命令: ${command}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    const invoked = fs.realpathSync(path.resolve(process.argv[1]));
    const current = fs.realpathSync(fileURLToPath(import.meta.url));
    return invoked === current;
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isDirectExecution()) {
  try { main(); } catch (error) {
    // Avoid echoing JSON parser excerpts, which may contain unredacted input.
    console.error(JSON.stringify({ error: error instanceof SyntaxError ? 'JSON 格式无效，请检查输入或流程元数据' : error.message }));
    process.exitCode = 1;
  }
}
