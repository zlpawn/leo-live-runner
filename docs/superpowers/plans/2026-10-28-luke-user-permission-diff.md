# Luke 人员权限画像与双人三层深度 Diff 实施计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Luke 权限中心单人全景权限画像查询（`user`）与双人三层深度 Diff 对比（`diff-user`），直出完整角色 Code、权限 Code、约束 Code、接口 URL 与控制台链接，并确立 AI 自然语言交付规范。

**Architecture:** 采用两层解耦架构：
1. **纯计算内核层 (`scripts/common/luke_diff_core.js`)**：内存双向索引构建、同名消歧、多角色约束并集合并（Union）、三层递进 Diff 算法（角色、权限点、约束取值），100% 静态夹具离线测试。
2. **网络编排与 CLI 渲染层 (`scripts/common/luke.js` & `scripts/luke_query.js`)**：分页排干（Page Draining，`pageSize: 100`）、并发批次控制（Batch size: 6）、控制台彩色表格与 `--json` 机器格式格式化输出。

**Tech Stack:** Node.js (ESM), `node:test`, `node:assert/strict`, 原生 JavaScript Map/Set 集合运算。

## Global Constraints

- 纯只读探查，绝不执行任何写操作（保持 Luke 两阶段风控原则）。
- 绝不依赖任何外部浏览器工具（严禁引入 opencli、ego-browser 等）。
- 零交互式挂起：同名消歧直接输出候选名单与角色供 AI 识别决策，不阻塞等待终端输入。
- 完整直出：角色 Code (`roleId`)、权限 Code (`permId`)、约束 Code (`extId`)、接口路径 (`apiUrl`) 以及控制台 Web URL (`portalUrl`)。
- 保证离线单元测试 100% 可重复运行，不依赖真实环境登录态。

---

### Task 1: 纯计算内核层 (Pure Computation Core)

**Files:**
- Create: `skills/leo-live-inspector/scripts/common/luke_diff_core.js`
- Test: `skills/leo-live-inspector/tests/luke-user-diff.test.mjs`

**Interfaces:**
- Produces:
  - `buildUserMemoryIndex(roles, roleUsersMap)`: `Map<ucid, UserProfile>` & `Map<name, Array<{ucid, name, roles}>>`
  - `resolveUserFromIndex(identifier, memoryIndex)`: `{ matched: true, ucid, name, roles } | { ambiguous: true, candidates } | { notFound: true }`
  - `aggregateEffectivePermissions(ucid, userRoles, allRolesMap, options)`: `UserProfile` (含 `roles`, `perms`, 合并后的 `exts`, `portalUrl`)
  - `diffUserProfiles(profileA, profileB, options)`: `UserDiffResult` (含 `summary`, `rolesDiff`, `permsDiff`, `constraintDiffs`)
  - `generatePortalUrl(env, appId, type, id)`: `string` (生成控制台直达 Web URL)

- [ ] **Step 1: 编写纯计算内核失败测试**

创建 `skills/leo-live-inspector/tests/luke-user-diff.test.mjs`，包含工号精准匹配、姓名消歧、过期过滤、约束并集合并、三层 Diff 及 100% 相同场景的断言：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUserMemoryIndex,
  resolveUserFromIndex,
  aggregateEffectivePermissions,
  diffUserProfiles,
  generatePortalUrl
} from '../scripts/common/luke_diff_core.js';

const mockRoles = [
  {
    id: 'anjiah5:inventoryAdmin',
    name: '安家H5-库存管理员',
    active: true,
    expireDate: '2099-12-31T23:59:59.000Z',
    perms: [
      {
        permId: 'anjia:lock:infoView',
        exts: [
          { extId: 'cityCode', value: ['310000'] },
          { extId: 'apiUrl', value: ['/api/v1/locks/info'] }
        ]
      },
      {
        permId: 'anjia:lock:delete',
        exts: [
          { extId: 'apiUrl', value: ['DELETE /api/v1/locks/:id'] }
        ]
      }
    ]
  },
  {
    id: 'common:employee',
    name: '普通员工',
    active: true,
    expireDate: '2099-12-31T23:59:59.000Z',
    perms: [
      {
        permId: 'anjia:lock:infoView',
        exts: [
          { extId: 'cityCode', value: ['110000', '310000'] },
          { extId: 'apiUrl', value: ['/api/v1/locks/detail'] }
        ]
      }
    ]
  },
  {
    id: 'device:operator',
    name: '设备操作员',
    active: true,
    expireDate: '2099-12-31T23:59:59.000Z',
    perms: [
      {
        permId: 'anjia:device:reboot',
        exts: [
          { extId: 'apiUrl', value: ['POST /api/v1/device/reboot'] }
        ]
      }
    ]
  },
  {
    id: 'expired:role',
    name: '过期角色',
    active: true,
    expireDate: '2020-01-01T00:00:00.000Z',
    perms: [{ permId: 'expired:perm', exts: [] }]
  }
];

const mockRoleUsersMap = {
  'anjiah5:inventoryAdmin': [
    { ucid: '1001', expireDate: '2099-12-31T23:59:59.000Z', user: { name: '张林' } }
  ],
  'common:employee': [
    { ucid: '1001', expireDate: '2099-12-31T23:59:59.000Z', user: { name: '张林' } },
    { ucid: '1002', expireDate: '2099-12-31T23:59:59.000Z', user: { name: '李四' } },
    { ucid: '1003', expireDate: '2099-12-31T23:59:59.000Z', user: { name: '王五' } }
  ],
  'device:operator': [
    { ucid: '1002', expireDate: '2099-12-31T23:59:59.000Z', user: { name: '李四' } },
    { ucid: '1004', expireDate: '2099-12-31T23:59:59.000Z', user: { name: '王五' } }
  ]
};

test('buildUserMemoryIndex & resolveUserFromIndex', () => {
  const index = buildUserMemoryIndex(mockRoles, mockRoleUsersMap);
  
  // 1. 工号精确匹配
  const byUcid = resolveUserFromIndex('1001', index);
  assert.equal(byUcid.matched, true);
  assert.equal(byUcid.user.name, '张林');
  assert.deepEqual(byUcid.roles.map(r => r.id), ['anjiah5:inventoryAdmin', 'common:employee']);

  // 2. 姓名唯一匹配
  const byName = resolveUserFromIndex('张林', index);
  assert.equal(byName.matched, true);
  assert.equal(byName.user.ucid, '1001');

  // 3. 同名消歧 (王五有 1003 与 1004)
  const ambiguous = resolveUserFromIndex('王五', index);
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.candidates.length, 2);
  assert.ok(ambiguous.candidates[0].roles.length > 0);

  // 4. 未知人员
  const notFound = resolveUserFromIndex('9999', index);
  assert.equal(notFound.notFound, true);
});

test('aggregateEffectivePermissions - merges constraints and filters expired roles', () => {
  const index = buildUserMemoryIndex(mockRoles, mockRoleUsersMap);
  const user1 = resolveUserFromIndex('1001', index);
  const rolesMap = new Map(mockRoles.map(r => [r.id, r]));

  const profile = aggregateEffectivePermissions(user1.user, user1.roles, rolesMap, { appId: 'iot_auth', env: 'test' });
  assert.equal(profile.user.ucid, '1001');
  assert.equal(profile.roles.length, 2);

  // 验证门锁查看权限的约束并集 (310000 + 110000)
  const lockInfoPerm = profile.perms.find(p => p.id === 'anjia:lock:infoView');
  assert.ok(lockInfoPerm);
  assert.deepEqual(lockInfoPerm.exts.cityCode.sort(), ['110000', '310000']);
  assert.deepEqual(lockInfoPerm.exts.apiUrl.sort(), ['/api/v1/locks/detail', '/api/v1/locks/info']);
  assert.ok(lockInfoPerm.portalUrl.includes('test-luke.ke.com'));
});

test('diffUserProfiles - 3-tier deep diff', () => {
  const index = buildUserMemoryIndex(mockRoles, mockRoleUsersMap);
  const rolesMap = new Map(mockRoles.map(r => [r.id, r]));

  const userA = resolveUserFromIndex('1001', index);
  const userB = resolveUserFromIndex('1002', index);

  const profileA = aggregateEffectivePermissions(userA.user, userA.roles, rolesMap, { appId: 'iot_auth', env: 'test' });
  const profileB = aggregateEffectivePermissions(userB.user, userB.roles, rolesMap, { appId: 'iot_auth', env: 'test' });

  const diff = diffUserProfiles(profileA, profileB);
  assert.equal(diff.summary.isIdentical, false);

  // 1. 角色层差异
  assert.deepEqual(diff.rolesDiff.onlyA.map(r => r.id), ['anjiah5:inventoryAdmin']);
  assert.deepEqual(diff.rolesDiff.onlyB.map(r => r.id), ['device:operator']);
  assert.deepEqual(diff.rolesDiff.both.map(r => r.id), ['common:employee']);

  // 2. 权限点层差异
  assert.deepEqual(diff.permsDiff.onlyA.map(p => p.id), ['anjia:lock:delete']);
  assert.deepEqual(diff.permsDiff.onlyB.map(p => p.id), ['anjia:device:reboot']);
  assert.deepEqual(diff.permsDiff.both.map(p => p.id), ['anjia:lock:infoView']);

  // 3. 约束下探差异 (User A 相比 User B 在 lock:infoView 约束取值不同)
  assert.ok(diff.constraintDiffs.length > 0);
  const cityDiff = diff.constraintDiffs.find(d => d.extId === 'cityCode');
  assert.ok(cityDiff);
  assert.deepEqual(cityDiff.onlyInA, []);
  assert.deepEqual(cityDiff.onlyInB, []);
  const apiDiff = diff.constraintDiffs.find(d => d.extId === 'apiUrl');
  assert.ok(apiDiff);
  assert.deepEqual(apiDiff.onlyInA, ['/api/v1/locks/info']);
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
node --test skills/leo-live-inspector/tests/luke-user-diff.test.mjs
```
预期：报错 `ERR_MODULE_NOT_FOUND`（模块尚未创建）。

- [ ] **Step 3: 实现 `scripts/common/luke_diff_core.js`**

编写纯计算函数逻辑，包含 `generatePortalUrl`、`buildUserMemoryIndex`、`resolveUserFromIndex`、`aggregateEffectivePermissions` 和 `diffUserProfiles`。

- [ ] **Step 4: 运行测试验证通过**

```bash
node --test skills/leo-live-inspector/tests/luke-user-diff.test.mjs
```
预期：所有断言全部 PASS。

- [ ] **Step 5: 提交代码**

```bash
git -C /Users/pa/project/LEO/leo-live-runner add skills/leo-live-inspector/scripts/common/luke_diff_core.js skills/leo-live-inspector/tests/luke-user-diff.test.mjs
git -C /Users/pa/project/LEO/leo-live-runner commit -m "feat(luke): implement pure computation core for user permissions and 3-tier diff"
```

---

### Task 2: 网络编排层接入 (Network Orchestrator in luke.js)

**Files:**
- Modify: `skills/leo-live-inspector/scripts/common/luke.js`
- Test: `skills/leo-live-inspector/tests/luke-user-diff.test.mjs`

**Interfaces:**
- Produces:
  - `fetchAppRolesWithUsers(appId, options)`: 并发分批拉取与分页排干
  - `getUserPermissions(appId, identifier, options)`: 组装拉取与画像聚合
  - `compareUserPermissions(appId, userA, userB, options)`: 组装拉取与三层 Diff
- Consumes:
  - `scripts/common/luke_diff_core.js` 导出的所有纯函数
  - `executeLukeGraphQL`, `listRoles`, `listRoleUsers`

- [ ] **Step 1: 编写网络编排导出测试**

在 `tests/luke-user-diff.test.mjs` 中添加针对 `scripts/common/luke.js` 新导出接口签名的断言。

- [ ] **Step 2: 运行测试验证失败**

```bash
node --test skills/leo-live-inspector/tests/luke-user-diff.test.mjs
```
预期：报错 `fetchAppRolesWithUsers is not a function`。

- [ ] **Step 3: 在 `scripts/common/luke.js` 中实现网络编排器**

实现分页排干（当 `roles.total > pageSize` 时循环翻页）以及并发分批控制器（Batch size: 6，使用分块执行 `Promise.all`），接入 `getUserPermissions` 与 `compareUserPermissions`。

- [ ] **Step 4: 运行测试验证通过**

```bash
node --test skills/leo-live-inspector/tests/luke-user-diff.test.mjs
```
预期：全部 PASS。

- [ ] **Step 5: 提交代码**

```bash
git -C /Users/pa/project/LEO/leo-live-runner add skills/leo-live-inspector/scripts/common/luke.js skills/leo-live-inspector/tests/luke-user-diff.test.mjs
git -C /Users/pa/project/LEO/leo-live-runner commit -m "feat(luke): add network orchestrators with page draining and concurrency pooling"
```

---

### Task 3: CLI 子命令与格式化渲染 (CLI Integration in luke_query.js)

**Files:**
- Modify: `skills/leo-live-inspector/scripts/luke_query.js`
- Test: `skills/leo-live-inspector/tests/luke-user-diff.test.mjs`

**Interfaces:**
- Produces:
  - CLI 子命令：`user <ucid|name>`
  - CLI 子命令：`diff-user <userA> <userB>`
  - 选项：`--app`, `-e/--env`, `--json`

- [ ] **Step 1: 编写 CLI 子命令集成测试**

在 `tests/luke-user-diff.test.mjs` 中使用 `execFile` 验证 `node scripts/luke_query.js --help` 包含 `user` 与 `diff-user` 说明。

- [ ] **Step 2: 运行测试验证失败**

```bash
node --test skills/leo-live-inspector/tests/luke-user-diff.test.mjs
```
预期：FAIL（子命令尚未登记在 help 文档中）。

- [ ] **Step 3: 在 `scripts/luke_query.js` 中接入路由与格式化展示**

1. 修改 `parseArgs`：增加 `positional[2]` 解析为 `targetId2`。
2. 更新 `printHelp()`：增加 `user` 与 `diff-user` 示例说明。
3. 实现 `case 'user'`：渲染员工基本信息、角色表（带 Code 与直达链接）、生效权限点表（带 Code、关联 API 路径与约束范围）。
4. 实现 `case 'diff-user'`：渲染概览统计、角色差异表、权限点差异表、约束深度下探差异表。若零差异输出“两人在当前系统下生效权限完全一致”。

- [ ] **Step 4: 运行测试验证通过**

```bash
node --test skills/leo-live-inspector/tests/luke-user-diff.test.mjs
```
预期：全部 PASS。

- [ ] **Step 5: 提交代码**

```bash
git -C /Users/pa/project/LEO/leo-live-runner add skills/leo-live-inspector/scripts/luke_query.js skills/leo-live-inspector/tests/luke-user-diff.test.mjs
git -C /Users/pa/project/LEO/leo-live-runner commit -m "feat(luke): add user and diff-user subcommands to luke_query CLI"
```

---

### Task 4: SKILL.md 文档与 AI 自然语言交付规范

**Files:**
- Modify: `skills/leo-live-inspector/SKILL.md`

- [ ] **Step 1: 更新 `SKILL.md` 核心能力与流程图**

1. 在核心能力第 8 项增加：“支持员工单人全景权限画像探查（`user <ucid|name>`）与双人三层深度 Diff 对比（`diff-user <user1> <user2>`）”。
2. 更新快速查阅表格，补充查员工权限与比对差异的命令指引。
3. 增加专题小节：`### 👤 员工权限全景画像与双人三层深度 Diff (User & Diff-User)`，详细列出命令格式、Code 与 URL 直出规范。
4. 明确建立【AI 自然语言交付与用户沟通规范】：强制 AI 严禁向用户直接倾倒 JSON，必须转译为业务人员一目了然的“人话”诊断结论。

- [ ] **Step 2: 全量回归测试**

```bash
npm test --prefix /Users/pa/project/LEO/leo-live-runner/skills/leo-live-inspector
```
预期：所有 107+ 项测试（包括旧有 106 项测试和新增测试）全部 PASS。

- [ ] **Step 3: 提交并推送到远端 GitHub**

```bash
git -C /Users/pa/project/LEO/leo-live-runner add skills/leo-live-inspector/SKILL.md
git -C /Users/pa/project/LEO/leo-live-runner commit -m "docs(luke): document user query, 3-tier diff and AI natural language delivery standard"
git -C /Users/pa/project/LEO/leo-live-runner push origin main
```

- [ ] **Step 4: 校验 `~/.agents/skills` 同步状态**

确认 `~/.agents/skills/leo-live-inspector/SKILL.md` 内容实时保持最新。
