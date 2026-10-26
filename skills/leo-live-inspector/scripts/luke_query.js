#!/usr/bin/env node

/**
 * 🔍 Leo Live Inspector - Luke 权限中心测试环境只读探查引擎 (Luke Permission Query Engine)
 * 
 * 核心特性：
 *   1. 纯 GraphQL/HTTP 极速直连：直连 test-luke.ke.com，平均响应 < 200ms；
 *   2. 覆盖完整 RBAC 核心实体：约束 (Ext)、权限点 (Perm)、角色 (Role)、人员绑定 (Users)；
 *   3. 自动凭据复用：支持 ~/.shrimp 缓存 Cookie 或命令行传入；
 *   4. 人性化排版与结构化数据交付：支持终端清晰表格输出和 `--json` 格式化数据输出。
 */

import {
  DEFAULT_APP_ID,
  listExts,
  getExt,
  listExtTypes,
  listExtTypeValues,
  listPerms,
  getPerm,
  listRoles,
  getRole,
  listRoleUsers
} from './common/luke.js';

function parseArgs(args) {
  const options = {
    command: null,
    targetId: null,
    appId: DEFAULT_APP_ID,
    env: 'test',
    keyword: null,
    page: 1,
    pageSize: 20,
    json: false,
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
    } else if (arg === '-q' || arg === '--keyword') {
      options.keyword = args[++i];
    } else if (arg === '--page') {
      options.page = parseInt(args[++i], 10) || 1;
    } else if (arg === '--page-size') {
      options.pageSize = parseInt(args[++i], 10) || 20;
    } else if (arg === '--cookie') {
      options.cookie = args[++i];
    } else if (arg === '--set-cookie') {
      options.setCookie = args[++i];
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  options.command = positional[0] || 'help';
  options.targetId = positional[1] || null;
  return options;
}

function printHelp() {
  console.log(`
🔍 Leo Luke Permission Query Engine (测试环境权限中心探查引擎)

使用格式:
  node scripts/luke_query.js <subcommand> [targetId] [options]

常用子命令:
  ext [extId]           查询约束字典列表或指定约束的枚举详情
  types                 查询系统已注册的自定义约束类型 (如 apiUrl, feBtn, feMenu)
  perm [permId]         查询权限点列表或指定权限点详情 (含挂载约束、默认值等)
  role [roleId]         查询角色列表或指定角色的权限树详情
  users <roleId>        查询指定角色下已绑定的员工列表

选项:
  --app <appId>         目标系统应用标识 (默认: iot_auth)
  -q, --keyword <str>   按标识或名称模糊检索
  --page <num>          当前页码 (默认: 1)
  --page-size <num>     分页大小 (默认: 20)
  --cookie <str>        临时覆盖使用的 Cookie
  --set-cookie <str>    保存 Cookie 至本地缓存供后续自动复用
  --json                输出机器可读的格式化 JSON
  -h, --help            查看本帮助说明

示例:
  node scripts/luke_query.js ext                        # 查看所有约束维度
  node scripts/luke_query.js ext serviceId              # 查看 serviceId 的所有枚举微服务
  node scripts/luke_query.js perm -q 门锁                # 检索包含“门锁”的权限点
  node scripts/luke_query.js perm anjia:lock:infoView   # 查看指定权限点的关联约束与接口
  node scripts/luke_query.js role -q 超管                # 检索超管角色
  node scripts/luke_query.js role admin                 # 查看 admin 角色的权限树与约束取值
  node scripts/luke_query.js users admin                # 查看 admin 角色绑定的员工
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || options.command === 'help') {
    printHelp();
    return;
  }

  const { command, targetId, appId, env, page, pageSize, keyword, json, cookie, setCookie } = options;
  const isProd = env === 'prod' || env === 'production';
  const envTag = isProd ? '🚨 线上生产环境 [luke.ke.com]' : '🧪 测试环境 [test-luke.ke.com]';

  try {
    switch (command) {
      case 'ext': {
        if (targetId) {
          const ext = await getExt(appId, targetId, { cookie, env });
          if (!ext) {
            console.error(`❌ [${envTag}] 未找到约束标识为 [${targetId}] 的约束项`);
            process.exit(1);
          }
          if (json) {
            console.log(JSON.stringify(ext, null, 2));
          } else {
            console.log(`\n📌 约束详情 (${envTag}): [${ext.id}] ${ext.name}`);
            console.log(`   类型: ${ext.kind} | 是否变量: ${ext.isVariable} | 更新时间: ${ext.updateDate || '未知'}`);
            if (ext.choices && ext.choices.length > 0) {
              console.log(`\n📋 枚举取值列表 (共 ${ext.choices.length} 项):`);
              console.table(ext.choices.map(c => ({ '枚举ID': c.id, '枚举名称': c.name })));
            } else {
              console.log(`   (非枚举类型或暂无选项)`);
            }
          }
        } else {
          const exts = await listExts(appId, { pager: { pageSize, current: page }, cookie, env });
          if (json) {
            console.log(JSON.stringify(exts, null, 2));
          } else {
            console.log(`\n📋 约束列表 (${envTag} | App: ${appId}, 共 ${exts.total} 项):`);
            console.table(exts.nodes.map(e => ({
              '约束标识 (id)': e.id,
              '约束名称 (name)': e.name,
              '类型 (kind)': e.kind,
              '枚举项数': e.choices ? e.choices.length : '-',
              '更新时间': (e.updateDate || '').slice(0, 10)
            })));
          }
        }
        break;
      }

      case 'types': {
        const types = await listExtTypes(appId, { cookie, env });
        if (json) {
          console.log(JSON.stringify(types, null, 2));
        } else {
          console.log(`\n🧩 自定义约束类型 (${envTag} | App: ${appId}, 共 ${types.total} 项):`);
          console.table(types.nodes.map(t => ({
            '类型编码 (code)': t.code,
            '类型名称 (name)': t.name,
            '已登记记录数 (nums)': t.nums
          })));
        }
        break;
      }

      case 'perm': {
        if (targetId) {
          const perm = await getPerm(appId, targetId, { cookie, env });
          if (!perm) {
            console.error(`❌ [${envTag}] 未找到权限点标识为 [${targetId}] 的记录`);
            process.exit(1);
          }
          if (json) {
            console.log(JSON.stringify(perm, null, 2));
          } else {
            console.log(`\n🔐 权限点详情 (${envTag}): [${perm.id}] ${perm.name}`);
            console.log(`   说明: ${perm.desc || '无'}`);
            console.log(`   创建时间: ${perm.createDate || '未知'}`);
            if (perm.security) {
              console.log(`   安全属性: 操作类型=${perm.security.action || '-'}, 等级=${perm.security.level || '-'}`);
            }
            if (perm.attachedExts && perm.attachedExts.length > 0) {
              console.log(`\n🔗 挂载关联约束 (共 ${perm.attachedExts.length} 个约束):`);
              perm.attachedExts.forEach(att => {
                const defValStr = Array.isArray(att.defaultValue)
                  ? att.defaultValue.join(', ')
                  : JSON.stringify(att.defaultValue);
                console.log(`   • [${att.id}] (必填:${att.required}, 多值:${att.multiple}) => 默认/候选值: ${defValStr}`);
              });
            } else {
              console.log(`   (无关联约束)`);
            }
          }
        } else {
          const filter = keyword ? { name: keyword } : null;
          const perms = await listPerms(appId, { filter, pager: { pageSize, current: page }, cookie, env });
          if (json) {
            console.log(JSON.stringify(perms, null, 2));
          } else {
            console.log(`\n🔐 权限点列表 (${envTag} | App: ${appId}, 共 ${perms.total} 项, 当前第 ${page} 页):`);
            console.table(perms.nodes.map(p => ({
              '权限点标识': p.id,
              '权限点名称': p.name,
              '关联约束数': p.attachedExts ? p.attachedExts.length : 0,
              '关联约束维度': (p.attachedExts || []).map(a => a.id).join(', '),
              '创建时间': (p.createDate || '').slice(0, 10)
            })));
          }
        }
        break;
      }

      case 'role': {
        if (targetId) {
          const role = await getRole(appId, targetId, { cookie, env });
          if (!role) {
            console.error(`❌ [${envTag}] 未找到角色标识为 [${targetId}] 的记录`);
            process.exit(1);
          }
          if (json) {
            console.log(JSON.stringify(role, null, 2));
          } else {
            console.log(`\n🎭 角色详情 (${envTag}): [${role.id}] ${role.name} (${role.name_en || '无英文名'})`);
            console.log(`   状态: ${role.active ? '✅ 已启用' : '⛔ 已禁用'} | 描述: ${role.desc || '无'}`);
            console.log(`   包含权限数: ${role.permNums || (role.perms ? role.perms.length : 0)} | 子角色数: ${role.childRoleNums || 0}`);
            if (role.perms && role.perms.length > 0) {
              console.log(`\n📜 拥有的权限点与限定约束:`);
              role.perms.forEach(rp => {
                console.log(`   • 权限点 [${rp.permId}]:`);
                if (rp.exts && rp.exts.length > 0) {
                  rp.exts.forEach(e => {
                    const valStr = Array.isArray(e.value) ? e.value.join(', ') : JSON.stringify(e.value);
                    console.log(`       └─ 约束 [${e.extId}] => ${valStr}`);
                  });
                } else {
                  console.log(`       └─ (无额外约束限定)`);
                }
              });
            }
          }
        } else {
          const roles = await listRoles(appId, { pager: { pageSize, current: page }, keyword, cookie, env });
          if (json) {
            console.log(JSON.stringify(roles, null, 2));
          } else {
            console.log(`\n🎭 角色列表 (${envTag} | App: ${appId}, 共 ${roles.total} 项, 当前第 ${page} 页):`);
            console.table(roles.nodes.map(r => ({
              '角色标识': r.id,
              '角色名称': r.name,
              '英文名': r.name_en || '-',
              '状态': r.active ? '已启用' : '已禁用',
              '权限数': r.permNums || 0,
              '子角色数': r.childRoleNums || 0,
              '更新时间': (r.updateDate || '').slice(0, 10)
            })));
          }
        }
        break;
      }

      case 'users': {
        if (!targetId) {
          console.error(`❌ 请提供角色标识，如: node scripts/luke_query.js users admin`);
          process.exit(1);
        }
        const users = await listRoleUsers(appId, targetId, { pager: { pageSize, current: page }, cookie, env });
        if (json) {
          console.log(JSON.stringify(users, null, 2));
        } else {
          console.log(`\n👥 角色 [${targetId}] 绑定的人员列表 (${envTag} | 共 ${users.total} 人):`);
          console.table(users.nodes.map(u => ({
            '员工工号 (ucid)': u.ucid,
            '姓名': u.user?.name || '-',
            '有效期': u.expireDate || '永久'
          })));
        }
        break;
      }

      default:
        console.error(`❌ 未知子命令: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`\n❌ 查询失败:`, err.message);
    process.exit(1);
  }
}

main();
