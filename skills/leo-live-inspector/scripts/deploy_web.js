#!/usr/bin/env node

/**
 * 🌐 Leo Live Inspector - 测试环境可视化控制台薄启动入口
 *
 * 页面与 HTTP 服务实现均独立封装在 ./web_console/ 目录下，
 * 便于未来随时与核心 CLI Skill 解耦或独立剥离。
 *
 * 用法:
 *   node scripts/deploy_web.js [--port 6886] [--open]
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startDeployWebConsole } from './web_console/server.js';

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startDeployWebConsole();
}
