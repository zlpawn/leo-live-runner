#!/usr/bin/env node

/**
 * 🛠️ Leo Live Inspector - Luke 权限中心变更与两阶段风控引擎 (Luke Permission Modifier)
 * 
 * 核心设计原则：
 *   1. 双轨环境支持 (Dual Environment):
 *      - 测试环境 (test, test-luke.ke.com)
 *      - 线上生产环境 (prod, luke.ke.com)
 *   2. 严格两阶段风控原则 (Pre-flight vs Confirmed):
 *      - 阶段 1 (默认 Dry-Run 试运行): 先查出当前配置，计算出【变更前 vs 变更后】Diff 对比单与影响面评估，
 *        绝对禁止未确认直接写入！
 *      - 阶段 2 (带 --confirm 正式执行): 用户明确确认后，追加 --confirm 正式调用 GraphQL Mutation 提交变更，
 *        并立即回查生效情况。
 *   3. 🚨 高危操作拦截与穿透评估 (Destructive Operations):
 *      - 针对【删除角色、删除权限点、从权限点中剔除 API、从角色中撤销权限、解绑员工】等缩减权限高危操作；
 *      - 强制穿透查询依赖此权限的所有角色和已绑定员工总数与名单；
 *      - 生产环境 (prod) 渲染醒目的【高危操作警示红框】，必须经过用户明确二次确认方可执行！
 */

import {
  DEFAULT_APP_ID,
  getExt,
  createExt,
  updateExt,
  deleteExt,
  getPerm,
  createPerm,
  updatePerm,
  deletePerm,
  getRole,
  listRoles,
  createRole,
  updateRole,
  updateRolePerms,
  deleteRole,
  listRoleUsers,
  createRoleUsers,
  deleteRoleUsers
} from './common/luke.js';

function parseArgs(args) {
  const options = {
    command: null,
    arg1: null,
    arg2: null,
    arg3: null,
    appId: DEFAULT_APP_ID,
    env: 'test',
    confirm: false,
    json: false,
    desc: null,
    nameEn: null,
    choices: null,
    addChoice: null,
    exts: null,
    addApi: [],
    removeApi: [],
    addMethod: [],
    removeMethod: [],
    addService: [],
    removeService: [],
    securityLevel: null,
    securityAction: null,
    duration: 0,
    cookie: null,
    setCookie: null
  };

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--app') {
      options.appId = args[++i];
    } else if (arg === '-e' || arg === '--env') {
      options.env = args[++i];
    } else if (arg === '--confirm') {
      options.confirm = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--desc') {
      options.desc = args[++i];
    } else if (arg === '--name-en') {
      options.nameEn = args[++i];
    } else if (arg === '--choices') {
      options.choices = args[++i];
    } else if (arg === '--add-choice') {
      options.addChoice = args[++i];
    } else if (arg === '--exts') {
      options.exts = args[++i];
    } else if (arg === '--add-api' || arg === '--api') {
      options.addApi.push(args[++i]);
    } else if (arg === '--remove-api') {
      options.removeApi.push(args[++i]);
    } else if (arg === '--add-method' || arg === '--method') {
      options.addMethod.push(args[++i]);
    } else if (arg === '--remove-method') {
      options.removeMethod.push(args[++i]);
    } else if (arg === '--add-service' || arg === '--service') {
      options.addService.push(args[++i]);
    } else if (arg === '--remove-service') {
      options.removeService.push(args[++i]);
    } else if (arg === '--security-level') {
      options.securityLevel = args[++i];
    } else if (arg === '--security-action') {
      options.securityAction = args[++i];
    } else if (arg === '--duration') {
      options.duration = parseInt(args[++i], 10) || 0;
    } else if (arg === '--cookie') {
      options.cookie = args[++i];
    } else if (arg === '--set-cookie') {
      options.setCookie = args[++i];
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  options.command = positional[0] || 'help';
  options.arg1 = positional[1] || null;
  options.arg2 = positional[2] || null;
  options.arg3 = positional[3] || null;
  return options;
}

function printHelp() {
  console.log(`
🛠️ Leo Luke Permission Modifier (测试与线上环境权限变更与两阶段风控引擎)

使用格式:
  node scripts/luke_modify.js <subcommand> [args...] [options]

环境选项:
  -e, --env <test|prod>  目标环境: test (默认, test-luke.ke.com) | prod (线上生产, luke.ke.com)
  --confirm              [关键] 明确确认真正执行写入 (默认仅输出 Diff 预审报告，不落盘写入)
  --app <appId>          目标应用标识 (默认: iot_auth)

常用子命令:
  1. 约束管理 (Ext):
     create-ext <id> <name> <kind>                 新建约束
     update-ext <id> [options]                     更新约束/追加枚举值 (两阶段)
     delete-ext <id>                               删除约束 (高危两阶段)

  2. 权限点管理 (Perm):
     create-perm <id> <name> [options]             新建权限点
     update-perm <id> [options]                    更新权限点配置 (追加/剔除 API 等，两阶段)
     delete-perm <id>                              删除权限点 (高危两阶段)

  3. 角色管理 (Role):
     create-role <id> <name> [options]             新建角色
     update-role <id> [options]                    修改角色基础信息 (名称/说明等，两阶段)
     grant-role-perm <roleId> <permId> [options]   为角色分配权限点并限定约束取值 (两阶段)
     revoke-role-perm <roleId> <permId>            从角色中移除指定权限点 (高危两阶段)
     delete-role <id>                              删除角色 (高危两阶段)

  4. 人员绑定 (Role Users):
     bind-role-user <roleId> <ucid> [duration]     绑定员工 (duration=0 为永久)
     unbind-role-user <roleId> <ucid>              解绑员工 (高危两阶段)

更新与微调选项:
  --api <url>            追加允许的 API 路径 (支持多次传入)
  --remove-api <url>     从权限点或角色中【剔除】API 路径 (高危缩减)
  --service <svc>        追加允许的微服务标识 (支持多次传入)
  --remove-service <svc> 【剔除】微服务标识
  --method <m>           追加允许的 HTTP 请求方法 (如 GET, POST)
  --remove-method <m>    【剔除】HTTP 请求方法
  --add-choice <id:name> 快捷追加单条枚举项 (如 'my-service:我的服务')
  --choices <json>       全量枚举项 JSON
  --exts <json>          挂载/分配的约束定义 JSON
  --desc <text>          说明/描述文本
  --name-en <en>         角色英文名
  --json                 输出结构化 JSON
  -h, --help             帮助说明
`);
}

function printDiffBox(title, diffList, { isProd = false, isDestructive = false } = {}) {
  const lineChar = isDestructive ? '!' : '=';
  const header = isDestructive
    ? `🚨🚨🚨【高危操作预审报告 (HIGH RISK DELETION)】: ${title} 🚨🚨🚨`
    : `📑 变更预审报告 (Pre-flight Diff): ${title}`;

  console.log(`\n${lineChar.repeat(70)}`);
  console.log(header);
  if (isProd) {
    console.log(`🔥 目标环境: 线上生产环境 [luke.ke.com] (请务必极其审慎，严防线上事故！)`);
  } else {
    console.log(`🧪 目标环境: 测试环境 [test-luke.ke.com]`);
  }
  console.log(`${lineChar.repeat(70)}`);
  console.table(diffList);
}

function printPreflightNotice(confirmCommand, { isProd = false, isDestructive = false } = {}) {
  console.log(`\n⚠️  [两阶段风控提示 - 试运行未真正写入]`);
  if (isDestructive) {
    console.log(`   ⛔ 本次包含【删除 / 缩减权限】高危操作！请仔细核验上方列出的受影响人员与关联角色！`);
  }
  if (isProd) {
    console.log(`   🚨 本次目标为【线上生产环境 (luke.ke.com)】，必须获得用户的明确指令后方可执行！`);
  }
  console.log(`   若确认无误，请向用户汇报该变更单并征求确认；`);
  console.log(`   用户明确确认后，请带上 --confirm 参数正式执行:`);
  console.log(`   👉 ${confirmCommand}\n`);
}

async function findRolesUsingPerm(appId, permId, { cookie, env } = {}) {
  try {
    const rolesData = await listRoles(appId, { pager: { pageSize: 100, current: 1 }, cookie, env });
    const matchedRoles = [];
    for (const r of rolesData.nodes || []) {
      const fullRole = await getRole(appId, r.id, { cookie, env });
      if (fullRole && (fullRole.perms || []).some(p => p.permId === permId)) {
        matchedRoles.push(fullRole);
      }
    }
    return matchedRoles;
  } catch {
    return [];
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || options.command === 'help') {
    printHelp();
    return;
  }

  const {
    command, arg1, arg2, arg3, appId, env, confirm, json, desc, nameEn,
    choices, addChoice, exts, addApi, removeApi, addMethod, removeMethod,
    addService, removeService, securityLevel, securityAction, duration, cookie
  } = options;

  const isProd = env === 'prod' || env === 'production';
  const envTag = isProd ? 'prod' : 'test';

  try {
    switch (command) {
      // ==================== 约束管理 (Ext) ====================
      case 'create-ext': {
        const id = arg1;
        const name = arg2;
        const kind = arg3 || 'Choice';
        if (!id || !name) {
          throw new Error('create-ext 需要提供 <id> 和 <name>，例如: node scripts/luke_modify.js create-ext myExt 我的约束 Choice');
        }

        let parsedChoices = [];
        if (choices) {
          try { parsedChoices = JSON.parse(choices); } catch (e) {
            throw new Error(`--choices JSON 格式错误: ${e.message}`);
          }
        }
        if (addChoice) {
          const [cid, cname] = addChoice.split(':');
          parsedChoices.push({ id: cid.trim(), name: (cname || cid).trim() });
        }

        // 线上生产环境即使是新建，也要先 Pre-flight
        if (isProd && !confirm) {
          const diff = [
            { '属性': '操作类型', '信息': '新建约束 (生产环境)' },
            { '属性': '约束标识', '信息': id },
            { '属性': '约束名称', '信息': name },
            { '属性': '约束类型', '信息': kind },
            { '属性': '初始枚举项', '信息': parsedChoices.map(c => `${c.id}:${c.name}`).join(', ') || '无' }
          ];
          printDiffBox(`新建约束 [${id}]`, diff, { isProd, isDestructive: false });
          printPreflightNotice(`node scripts/luke_modify.js create-ext ${id} "${name}" ${kind} -e prod --confirm`, { isProd, isDestructive: false });
          return;
        }

        const input = {
          id,
          name,
          kind,
          isVariable: true,
          choices: parsedChoices.length > 0 ? parsedChoices : null
        };

        const res = await createExt(appId, input, { cookie, env: envTag });
        console.log(`\n✅ [${isProd ? '线上生产' : '测试环境'}] 约束 [${res.id}] 创建成功！名称: ${res.name}, 类型: ${kind}`);
        break;
      }

      case 'update-ext': {
        const id = arg1;
        if (!id) throw new Error('update-ext 需要提供 <id>');

        const current = await getExt(appId, id, { cookie, env: envTag });
        if (!current) throw new Error(`未找到约束 [${id}]`);

        let targetName = arg2 || current.name;
        let targetKind = current.kind;
        let targetChoices = current.choices ? [...current.choices] : [];

        if (choices) {
          try { targetChoices = JSON.parse(choices); } catch (e) {
            throw new Error(`--choices JSON 格式错误: ${e.message}`);
          }
        }
        if (addChoice) {
          const [cid, cname] = addChoice.split(':');
          const existingIdx = targetChoices.findIndex(c => c.id === cid.trim());
          if (existingIdx >= 0) {
            targetChoices[existingIdx] = { id: cid.trim(), name: (cname || cid).trim() };
          } else {
            targetChoices.push({ id: cid.trim(), name: (cname || cid).trim() });
          }
        }

        const diff = [
          { '属性': '约束名称', '变更前 (Current)': current.name, '变更后 (Target)': targetName },
          { '属性': '约束类型', '变更前 (Current)': current.kind, '变更后 (Target)': targetKind },
          {
            '属性': '枚举数量',
            '变更前 (Current)': current.choices ? current.choices.length : 0,
            '变更后 (Target)': targetChoices.length
          },
          {
            '属性': '枚举项差异',
            '变更前 (Current)': (current.choices || []).map(c => c.id).join(', '),
            '变更后 (Target)': targetChoices.map(c => c.id).join(', ')
          }
        ];

        printDiffBox(`更新约束 [${id}]`, diff, { isProd, isDestructive: false });

        if (!confirm) {
          const confirmCmd = `node scripts/luke_modify.js update-ext ${id} "${targetName}" -e ${envTag} --confirm ${addChoice ? `--add-choice "${addChoice}"` : ''}`;
          printPreflightNotice(confirmCmd, { isProd, isDestructive: false });
          return;
        }

        const input = {
          id,
          name: targetName,
          kind: targetKind,
          isVariable: true,
          choices: targetChoices
        };

        const updated = await updateExt(appId, input, { cookie, env: envTag });
        console.log(`\n🎉 [${isProd ? '线上生产' : '测试环境'}] 约束 [${updated.id}] 已正式更新生效！`);
        break;
      }

      case 'delete-ext': {
        const id = arg1;
        if (!id) throw new Error('delete-ext 需要提供 <id>');

        const current = await getExt(appId, id, { cookie, env: envTag });
        if (!current) throw new Error(`约束 [${id}] 不存在`);

        const diff = [
          { '属性': '操作类型', '信息': '【彻底删除约束】' },
          { '属性': '约束标识', '信息': current.id },
          { '属性': '约束名称', '信息': current.name },
          { '属性': '高危警示', '信息': '如果已有权限点或业务代码依赖此约束，删除将导致接口鉴权规则缺失！' }
        ];

        printDiffBox(`删除约束 [${id}]`, diff, { isProd, isDestructive: true });

        if (!confirm) {
          printPreflightNotice(`node scripts/luke_modify.js delete-ext ${id} -e ${envTag} --confirm`, { isProd, isDestructive: true });
          return;
        }

        await deleteExt(appId, id, { cookie, env: envTag });
        console.log(`\n🗑️ [${isProd ? '线上生产' : '测试环境'}] 约束 [${id}] 已成功删除！`);
        break;
      }

      // ==================== 权限点管理 (Perm) ====================
      case 'create-perm': {
        const id = arg1;
        const name = arg2;
        if (!id || !name) {
          throw new Error('create-perm 需要提供 <id> 和 <name>，例如: node scripts/luke_modify.js create-perm anjia:test:perm 测试权限点');
        }

        let parsedAttachedExts = [];
        if (exts) {
          try { parsedAttachedExts = JSON.parse(exts); } catch (e) {
            throw new Error(`--exts JSON 格式错误: ${e.message}`);
          }
        }

        if (addApi.length > 0 || addMethod.length > 0 || addService.length > 0) {
          if (addService.length > 0 && !parsedAttachedExts.some(a => a.id === 'serviceId')) {
            parsedAttachedExts.push({ id: 'serviceId', required: true, multiple: true, defaultValue: addService });
          }
          if (addMethod.length > 0 && !parsedAttachedExts.some(a => a.id === 'requestMethod')) {
            parsedAttachedExts.push({ id: 'requestMethod', required: true, multiple: true, defaultValue: addMethod });
          }
          if (addApi.length > 0 && !parsedAttachedExts.some(a => a.id === 'apiUrl')) {
            parsedAttachedExts.push({ id: 'apiUrl', required: true, multiple: true, defaultValue: addApi });
          }
          if (!parsedAttachedExts.some(a => a.id === 'permType')) {
            parsedAttachedExts.push({ id: 'permType', required: true, multiple: true, defaultValue: ['BE_API'] });
          }
        }

        // 生产环境创建新权限点，也执行 Pre-flight 预审
        if (isProd && !confirm) {
          const diff = [
            { '属性': '操作类型', '信息': '新建权限点 (生产环境)' },
            { '属性': '权限点标识', '信息': id },
            { '属性': '权限点名称', '信息': name },
            { '属性': '关联接口 (apiUrl)', '信息': addApi.join(', ') || '未指定' },
            { '属性': '关联服务 (serviceId)', '信息': addService.join(', ') || '未指定' }
          ];
          printDiffBox(`新建权限点 [${id}]`, diff, { isProd, isDestructive: false });
          printPreflightNotice(`node scripts/luke_modify.js create-perm ${id} "${name}" -e prod --confirm`, { isProd, isDestructive: false });
          return;
        }

        const input = {
          id,
          name,
          desc: desc || '',
          attachedExts: parsedAttachedExts,
          excludeIds: [],
          security: securityLevel || securityAction ? {
            level: securityLevel || 'C1',
            action: securityAction || 'create'
          } : null
        };

        const res = await createPerm(appId, input, { cookie, env: envTag });
        console.log(`\n✅ [${isProd ? '线上生产' : '测试环境'}] 权限点 [${res.id}] 创建成功！名称: ${res.name}`);
        console.log(`   挂载约束数: ${parsedAttachedExts.length} 个`);
        break;
      }

      case 'update-perm': {
        const id = arg1;
        if (!id) throw new Error('update-perm 需要提供 <id>');

        const current = await getPerm(appId, id, { cookie, env: envTag });
        if (!current) throw new Error(`未找到权限点 [${id}]`);

        let targetName = arg2 || current.name;
        let targetDesc = desc !== null ? desc : (current.desc || '');
        let targetAttached = current.attachedExts ? JSON.parse(JSON.stringify(current.attachedExts)) : [];

        // 识别是否有删除/剔除接口操作 (高危)
        const isRemoving = removeApi.length > 0 || removeService.length > 0 || removeMethod.length > 0;

        // 追加 API
        if (addApi.length > 0) {
          let apiExt = targetAttached.find(a => a.id === 'apiUrl');
          if (!apiExt) {
            apiExt = { id: 'apiUrl', required: true, multiple: true, defaultValue: [] };
            targetAttached.push(apiExt);
          }
          apiExt.defaultValue = Array.from(new Set([...(apiExt.defaultValue || []), ...addApi]));
        }

        // 剔除 API (高危)
        if (removeApi.length > 0) {
          let apiExt = targetAttached.find(a => a.id === 'apiUrl');
          if (apiExt && Array.isArray(apiExt.defaultValue)) {
            apiExt.defaultValue = apiExt.defaultValue.filter(url => !removeApi.includes(url));
          }
        }

        // 追加/剔除 Method
        if (addMethod.length > 0) {
          let methodExt = targetAttached.find(a => a.id === 'requestMethod');
          if (!methodExt) {
            methodExt = { id: 'requestMethod', required: true, multiple: true, defaultValue: [] };
            targetAttached.push(methodExt);
          }
          methodExt.defaultValue = Array.from(new Set([...(methodExt.defaultValue || []), ...addMethod]));
        }
        if (removeMethod.length > 0) {
          let methodExt = targetAttached.find(a => a.id === 'requestMethod');
          if (methodExt && Array.isArray(methodExt.defaultValue)) {
            methodExt.defaultValue = methodExt.defaultValue.filter(m => !removeMethod.includes(m));
          }
        }

        // 追加/剔除 Service
        if (addService.length > 0) {
          let serviceExt = targetAttached.find(a => a.id === 'serviceId');
          if (!serviceExt) {
            serviceExt = { id: 'serviceId', required: true, multiple: true, defaultValue: [] };
            targetAttached.push(serviceExt);
          }
          serviceExt.defaultValue = Array.from(new Set([...(serviceExt.defaultValue || []), ...addService]));
        }
        if (removeService.length > 0) {
          let serviceExt = targetAttached.find(a => a.id === 'serviceId');
          if (serviceExt && Array.isArray(serviceExt.defaultValue)) {
            serviceExt.defaultValue = serviceExt.defaultValue.filter(s => !removeService.includes(s));
          }
        }

        const getSummary = (attached, key) => {
          const item = attached.find(a => a.id === key);
          if (!item || !item.defaultValue) return '无';
          return Array.isArray(item.defaultValue) ? item.defaultValue.join(', ') : JSON.stringify(item.defaultValue);
        };

        // 穿透探查受影响角色
        const dependentRoles = await findRolesUsingPerm(appId, id, { cookie, env: envTag });

        const diff = [
          { '属性': '权限点名称', '变更前': current.name, '变更后': targetName },
          { '属性': '权限点说明', '变更前': current.desc || '无', '变更后': targetDesc || '无' },
          { '属性': '关联服务 (serviceId)', '变更前': getSummary(current.attachedExts || [], 'serviceId'), '变更后': getSummary(targetAttached, 'serviceId') },
          { '属性': '关联请求方法 (requestMethod)', '变更前': getSummary(current.attachedExts || [], 'requestMethod'), '变更后': getSummary(targetAttached, 'requestMethod') },
          { '属性': '关联接口 (apiUrl)', '变更前': getSummary(current.attachedExts || [], 'apiUrl'), '变更后': getSummary(targetAttached, 'apiUrl') },
          {
            '属性': '级联影响角色数',
            '变更前': `${dependentRoles.length} 个角色使用此权限点`,
            '变更后': `包含: ${dependentRoles.map(r => r.name).slice(0, 5).join(', ')}${dependentRoles.length > 5 ? '等' : ''}`
          }
        ];

        if (removeApi.length > 0) {
          diff.push({
            '属性': '⚠️ 剔除的接口',
            '变更前': '-',
            '变更后': removeApi.join(', ')
          });
        }

        printDiffBox(`更新权限点 [${id}]`, diff, { isProd, isDestructive: isRemoving });

        if (!confirm) {
          let extraFlags = '';
          if (addApi.length > 0) extraFlags += addApi.map(a => ` --api "${a}"`).join('');
          if (removeApi.length > 0) extraFlags += removeApi.map(a => ` --remove-api "${a}"`).join('');
          if (addService.length > 0) extraFlags += addService.map(s => ` --service "${s}"`).join('');
          if (removeService.length > 0) extraFlags += removeService.map(s => ` --remove-service "${s}"`).join('');
          printPreflightNotice(`node scripts/luke_modify.js update-perm ${id} -e ${envTag} --confirm${extraFlags}`, { isProd, isDestructive: isRemoving });
          return;
        }

        const input = {
          id,
          name: targetName,
          desc: targetDesc,
          attachedExts: targetAttached,
          excludeIds: current.excludeIds || []
        };

        await updatePerm(appId, input, { cookie, env: envTag });
        console.log(`\n🎉 [${isProd ? '线上生产' : '测试环境'}] 权限点 [${id}] 已成功更新并生效！`);
        break;
      }

      case 'delete-perm': {
        const id = arg1;
        if (!id) throw new Error('delete-perm 需要提供 <id>');

        const current = await getPerm(appId, id, { cookie, env: envTag });
        if (!current) throw new Error(`权限点 [${id}] 不存在`);

        const dependentRoles = await findRolesUsingPerm(appId, id, { cookie, env: envTag });

        const diff = [
          { '属性': '操作类型', '信息': '【彻底删除权限点 (高危)】' },
          { '属性': '权限点标识', '信息': current.id },
          { '属性': '权限点名称', '信息': current.name },
          {
            '属性': '级联影响角色',
            '信息': `共有 ${dependentRoles.length} 个角色正在使用此权限点 (${dependentRoles.map(r => r.name).join(', ')})！删除可能导致这些角色的对应接口全部鉴权失败！`
          }
        ];

        printDiffBox(`删除权限点 [${id}]`, diff, { isProd, isDestructive: true });

        if (!confirm) {
          printPreflightNotice(`node scripts/luke_modify.js delete-perm ${id} -e ${envTag} --confirm`, { isProd, isDestructive: true });
          return;
        }

        await deletePerm(appId, id, { cookie, env: envTag });
        console.log(`\n🗑️ [${isProd ? '线上生产' : '测试环境'}] 权限点 [${id}] 已成功删除！`);
        break;
      }

      // ==================== 角色管理 (Role) ====================
      case 'create-role': {
        const id = arg1;
        const name = arg2;
        if (!id || !name) {
          throw new Error('create-role 需要提供 <id> 和 <name>，例如: node scripts/luke_modify.js create-role myRole 我的角色');
        }

        if (isProd && !confirm) {
          const diff = [
            { '属性': '操作类型', '信息': '新建角色 (生产环境)' },
            { '属性': '角色标识', '信息': id },
            { '属性': '角色名称', '信息': name },
            { '属性': '英文名', '信息': nameEn || id },
            { '属性': '角色描述', '信息': desc || '无' }
          ];
          printDiffBox(`新建角色 [${id}]`, diff, { isProd, isDestructive: false });
          printPreflightNotice(`node scripts/luke_modify.js create-role ${id} "${name}" -e prod --confirm`, { isProd, isDestructive: false });
          return;
        }

        const input = {
          id,
          name,
          name_en: nameEn || id,
          desc: desc || '',
          perms: []
        };

        const res = await createRole(appId, input, { cookie, env: envTag });
        console.log(`\n✅ [${isProd ? '线上生产' : '测试环境'}] 角色 [${res.id}] 创建成功！名称: ${res.name}`);
        break;
      }

      case 'update-role': {
        const id = arg1;
        if (!id) throw new Error('update-role 需要提供 <id>');

        const current = await getRole(appId, id, { cookie, env: envTag });
        if (!current) throw new Error(`未找到角色 [${id}]`);

        const targetName = arg2 || current.name;
        const targetDesc = desc !== null ? desc : (current.desc || '');
        const targetNameEn = nameEn || current.name_en;

        const diff = [
          { '属性': '角色名称', '变更前': current.name, '变更后': targetName },
          { '属性': '角色英文名', '变更前': current.name_en || '-', '变更后': targetNameEn || '-' },
          { '属性': '角色描述', '变更前': current.desc || '-', '变更后': targetDesc || '-' }
        ];

        printDiffBox(`修改角色基本信息 [${id}]`, diff, { isProd, isDestructive: false });

        if (!confirm) {
          printPreflightNotice(`node scripts/luke_modify.js update-role ${id} "${targetName}" -e ${envTag} --confirm`, { isProd, isDestructive: false });
          return;
        }

        const input = {
          id,
          name: targetName,
          name_en: targetNameEn,
          desc: targetDesc,
          active: current.active
        };

        await updateRole(appId, input, { cookie, env: envTag });
        console.log(`\n🎉 [${isProd ? '线上生产' : '测试环境'}] 角色 [${id}] 基础信息更新成功！`);
        break;
      }

      case 'grant-role-perm': {
        const roleId = arg1;
        const permId = arg2;
        if (!roleId || !permId) {
          throw new Error('grant-role-perm 需要提供 <roleId> 和 <permId>');
        }

        const role = await getRole(appId, roleId, { cookie, env: envTag });
        if (!role) throw new Error(`未找到角色 [${roleId}]`);

        const perm = await getPerm(appId, permId, { cookie, env: envTag });
        if (!perm) throw new Error(`未找到权限点 [${permId}]`);

        const users = await listRoleUsers(appId, roleId, { pager: { pageSize: 15, current: 1 }, cookie, env: envTag });

        let currentPerms = role.perms ? JSON.parse(JSON.stringify(role.perms)) : [];
        let targetRolePerm = currentPerms.find(p => p.permId === permId);

        let isNewPerm = false;
        if (!targetRolePerm) {
          isNewPerm = true;
          targetRolePerm = { permId, exts: [] };
          currentPerms.push(targetRolePerm);
        }

        let targetExts = targetRolePerm.exts ? [...targetRolePerm.exts] : [];

        if (isNewPerm && perm.attachedExts) {
          perm.attachedExts.forEach(att => {
            if (!targetExts.some(e => e.extId === att.id)) {
              targetExts.push({
                extId: att.id,
                value: att.defaultValue || []
              });
            }
          });
        }

        // 追加 API
        if (addApi.length > 0) {
          let e = targetExts.find(x => x.extId === 'apiUrl');
          if (!e) { e = { extId: 'apiUrl', value: [] }; targetExts.push(e); }
          e.value = Array.from(new Set([...(e.value || []), ...addApi]));
        }
        // 剔除 API (高危缩减)
        if (removeApi.length > 0) {
          let e = targetExts.find(x => x.extId === 'apiUrl');
          if (e && Array.isArray(e.value)) {
            e.value = e.value.filter(url => !removeApi.includes(url));
          }
        }

        // 追加/剔除 Method
        if (addMethod.length > 0) {
          let e = targetExts.find(x => x.extId === 'requestMethod');
          if (!e) { e = { extId: 'requestMethod', value: [] }; targetExts.push(e); }
          e.value = Array.from(new Set([...(e.value || []), ...addMethod]));
        }
        if (removeMethod.length > 0) {
          let e = targetExts.find(x => x.extId === 'requestMethod');
          if (e && Array.isArray(e.value)) {
            e.value = e.value.filter(m => !removeMethod.includes(m));
          }
        }

        // 追加/剔除 Service
        if (addService.length > 0) {
          let e = targetExts.find(x => x.extId === 'serviceId');
          if (!e) { e = { extId: 'serviceId', value: [] }; targetExts.push(e); }
          e.value = Array.from(new Set([...(e.value || []), ...addService]));
        }
        if (removeService.length > 0) {
          let e = targetExts.find(x => x.extId === 'serviceId');
          if (e && Array.isArray(e.value)) {
            e.value = e.value.filter(s => !removeService.includes(s));
          }
        }

        targetRolePerm.exts = targetExts;

        const isRemoving = removeApi.length > 0 || removeService.length > 0 || removeMethod.length > 0;

        const diff = [
          { '属性': '目标角色', '信息': `[${role.id}] ${role.name}` },
          { '属性': '分配权限点', '信息': `[${perm.id}] ${perm.name} (${isNewPerm ? '✨ 全新赋予' : '📝 修改现有约束'})` },
          {
            '属性': '限定约束维度',
            '信息': targetExts.map(e => `${e.extId}: [${(e.value || []).join(', ')}]`).join('\n')
          },
          {
            '属性': '受影响人员数',
            '信息': `共 ${users.total} 人 (例: ${users.nodes.map(u => u.user?.name || u.ucid).slice(0, 5).join(', ')}${users.total > 5 ? '等' : ''})`
          }
        ];

        if (removeApi.length > 0) {
          diff.push({
            '属性': '⚠️ 剔除收窄的接口',
            '信息': removeApi.join(', ')
          });
        }

        printDiffBox(`角色授权与约束分配: [${roleId}] <- [${permId}]`, diff, { isProd, isDestructive: isRemoving });

        if (!confirm) {
          let extraFlags = '';
          if (addApi.length > 0) extraFlags += addApi.map(a => ` --api "${a}"`).join('');
          if (removeApi.length > 0) extraFlags += removeApi.map(a => ` --remove-api "${a}"`).join('');
          if (addService.length > 0) extraFlags += addService.map(s => ` --service "${s}"`).join('');
          if (removeService.length > 0) extraFlags += removeService.map(s => ` --remove-service "${s}"`).join('');
          printPreflightNotice(`node scripts/luke_modify.js grant-role-perm ${roleId} ${permId} -e ${envTag} --confirm${extraFlags}`, { isProd, isDestructive: isRemoving });
          return;
        }

        const inputPerms = currentPerms.map(p => ({
          permId: p.permId,
          exts: (p.exts || []).map(e => ({
            extId: e.extId,
            value: e.value
          }))
        }));

        await updateRolePerms(appId, roleId, inputPerms, [], { cookie, env: envTag });
        console.log(`\n🎉 [${isProd ? '线上生产' : '测试环境'}] 角色 [${roleId}] 权限已成功更新并生效！当前拥有 ${inputPerms.length} 个权限点。`);
        break;
      }

      case 'revoke-role-perm': {
        const roleId = arg1;
        const permId = arg2;
        if (!roleId || !permId) throw new Error('revoke-role-perm 需要提供 <roleId> 和 <permId>');

        const role = await getRole(appId, roleId, { cookie, env: envTag });
        if (!role) throw new Error(`未找到角色 [${roleId}]`);

        const users = await listRoleUsers(appId, roleId, { pager: { pageSize: 15, current: 1 }, cookie, env: envTag });
        const currentPerms = role.perms ? [...role.perms] : [];
        const exists = currentPerms.some(p => p.permId === permId);
        if (!exists) throw new Error(`角色 [${roleId}] 本身未包含权限点 [${permId}]`);

        const diff = [
          { '属性': '操作类型', '信息': '【从角色中撤销权限点 (高危)】' },
          { '属性': '目标角色', '信息': `[${role.id}] ${role.name}` },
          { '属性': '撤销的权限点', '信息': permId },
          { '属性': '原权限点总数', '信息': currentPerms.length },
          { '属性': '撤销后总数', '信息': currentPerms.length - 1 },
          {
            '属性': '受影响人员',
            '信息': `该角色下的 ${users.total} 名员工将立即失去该权限点对应的所有接口访问权！(名单: ${users.nodes.map(u => u.user?.name || u.ucid).slice(0, 5).join(', ')}${users.total > 5 ? '等' : ''})`
          }
        ];

        printDiffBox(`移除角色权限点: [${roleId}] - [${permId}]`, diff, { isProd, isDestructive: true });

        if (!confirm) {
          printPreflightNotice(`node scripts/luke_modify.js revoke-role-perm ${roleId} ${permId} -e ${envTag} --confirm`, { isProd, isDestructive: true });
          return;
        }

        const nextPerms = currentPerms
          .filter(p => p.permId !== permId)
          .map(p => ({
            permId: p.permId,
            exts: (p.exts || []).map(e => ({ extId: e.extId, value: e.value }))
          }));

        await updateRolePerms(appId, roleId, nextPerms, [], { cookie, env: envTag });
        console.log(`\n🎉 [${isProd ? '线上生产' : '测试环境'}] 权限点 [${permId}] 已成功从角色 [${roleId}] 中移除！`);
        break;
      }

      case 'delete-role': {
        const id = arg1;
        if (!id) throw new Error('delete-role 需要提供 <id>');

        const current = await getRole(appId, id, { cookie, env: envTag });
        if (!current) throw new Error(`角色 [${id}] 不存在`);

        const users = await listRoleUsers(appId, id, { pager: { pageSize: 20, current: 1 }, cookie, env: envTag });

        const diff = [
          { '属性': '操作类型', '信息': '【彻底删除角色 (极其高危)】' },
          { '属性': '角色标识', '信息': current.id },
          { '属性': '角色名称', '信息': current.name },
          { '属性': '拥有权限数', '信息': current.perms ? current.perms.length : 0 },
          {
            '属性': '绑定的员工',
            '信息': `当前绑定了 ${users.total} 名员工！删除角色后，这 ${users.total} 人将全部解绑并丧失角色包含的全部权限！`
          }
        ];

        printDiffBox(`删除角色 [${id}]`, diff, { isProd, isDestructive: true });

        if (!confirm) {
          printPreflightNotice(`node scripts/luke_modify.js delete-role ${id} -e ${envTag} --confirm`, { isProd, isDestructive: true });
          return;
        }

        await deleteRole(appId, id, { cookie, env: envTag });
        console.log(`\n🗑️ [${isProd ? '线上生产' : '测试环境'}] 角色 [${id}] 已成功删除！`);
        break;
      }

      // ==================== 人员绑定 (Role Users) ====================
      case 'bind-role-user': {
        const roleId = arg1;
        const ucid = arg2;
        if (!roleId || !ucid) throw new Error('bind-role-user 需要提供 <roleId> 和 <ucid>');

        const role = await getRole(appId, roleId, { cookie, env: envTag });
        if (!role) throw new Error(`未找到角色 [${roleId}]`);

        if (isProd && !confirm) {
          const diff = [
            { '属性': '操作类型', '信息': '绑定员工到角色 (生产环境)' },
            { '属性': '目标角色', '信息': `[${role.id}] ${role.name}` },
            { '属性': '员工工号', '信息': ucid },
            { '属性': '有效期', '信息': duration === 0 ? '永久有效' : `${duration} 天` }
          ];
          printDiffBox(`绑定员工 [${ucid}] -> 角色 [${roleId}]`, diff, { isProd, isDestructive: false });
          printPreflightNotice(`node scripts/luke_modify.js bind-role-user ${roleId} ${ucid} ${duration} -e prod --confirm`, { isProd, isDestructive: false });
          return;
        }

        await createRoleUsers(appId, roleId, [ucid], { duration, cookie, env: envTag });
        console.log(`\n✅ [${isProd ? '线上生产' : '测试环境'}] 员工 [${ucid}] 已成功绑定角色 [${roleId}] (${role.name})！有效期: ${duration === 0 ? '永久' : `${duration} 天`}`);
        break;
      }

      case 'unbind-role-user': {
        const roleId = arg1;
        const ucid = arg2;
        if (!roleId || !ucid) throw new Error('unbind-role-user 需要提供 <roleId> 和 <ucid>');

        const role = await getRole(appId, roleId, { cookie, env: envTag });
        if (!role) throw new Error(`未找到角色 [${roleId}]`);

        const diff = [
          { '属性': '操作类型', '信息': '【解绑员工角色 (高危缩权)】' },
          { '属性': '目标角色', '信息': `[${role.id}] ${role.name}` },
          { '属性': '解绑员工工号', '信息': ucid },
          { '属性': '影响', '信息': `该员工将被立即移除此角色，丧失此角色所赋有的全部业务接口与菜单权限！` }
        ];

        printDiffBox(`解绑员工 [${ucid}] <- 角色 [${roleId}]`, diff, { isProd, isDestructive: true });

        if (!confirm) {
          printPreflightNotice(`node scripts/luke_modify.js unbind-role-user ${roleId} ${ucid} -e ${envTag} --confirm`, { isProd, isDestructive: true });
          return;
        }

        await deleteRoleUsers(appId, roleId, [ucid], { cookie, env: envTag });
        console.log(`\n🗑️ [${isProd ? '线上生产' : '测试环境'}] 员工 [${ucid}] 已成功从角色 [${roleId}] 中解绑！`);
        break;
      }

      default:
        console.error(`❌ 未知子命令: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`\n❌ 执行失败:`, err.message);
    process.exit(1);
  }
}

main();
