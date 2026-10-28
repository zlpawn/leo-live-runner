/**
 * Luke 人员权限画像与双人三层深度 Diff 纯计算内核 (Pure Computation Core)
 *
 * 职责：
 * 1. Luke 控制台 URL 生成 (generatePortalUrl)
 * 2. 内存双向索引构建与同名人员消歧 (buildUserMemoryIndex, resolveUserFromIndex)
 * 3. 单人有效权限点汇聚与约束并集合并 (aggregateEffectivePermissions)
 * 4. 双人三层递进 Diff 比对算法 (diffUserProfiles: 角色层 -> 权限点层 -> 约束下探层)
 *
 * 特性：零外部依赖、零网络 I/O、100% 静态数据离线可重放。
 */

export const EXT_NAMES = {
  cityCode: '城市编码',
  apiUrl: '接口路径',
  serviceId: '微服务标识',
  roleId: '角色标识'
};

/**
 * 生成 Luke 控制台 Web 直达 URL
 * @param {'test'|'prod'} [env='test'] 环境标识
 * @param {string} [appId='iot_auth'] 系统标识
 * @param {'role'|'perm'|''} [type=''] 资源类型
 * @param {string} [id=''] 资源标识
 * @returns {string} 控制台直达 URL
 */
export function generatePortalUrl(env = 'test', appId = 'iot_auth', type = '', id = '') {
  const host = env === 'prod' ? 'luke.ke.com' : 'test-luke.ke.com';
  if (type === 'role') {
    return `https://${host}/#/role/detail?appId=${appId}&id=${id}`;
  }
  if (type === 'perm') {
    return `https://${host}/#/perm/detail?appId=${appId}&id=${id}`;
  }
  return `https://${host}/#/?appId=${appId}`;
}

/**
 * 根据全量角色列表与角色人员映射构建内存双向索引
 * @param {Array<Object>} [roles=[]] 角色列表
 * @param {Object|Map} [roleUsersMap={}] 角色与绑定用户映射
 * @returns {{ ucidToUser: Map, nameToUsers: Map }}
 */
export function buildUserMemoryIndex(roles = [], roleUsersMap = {}) {
  const rolesById = new Map();
  for (const role of roles) {
    if (role && role.id) {
      rolesById.set(role.id, role);
    }
  }

  const ucidToUser = new Map();
  const nameToUsers = new Map();

  const entries = roleUsersMap instanceof Map
    ? roleUsersMap.entries()
    : Object.entries(roleUsersMap || {});

  for (const [roleId, userList] of entries) {
    const roleMeta = rolesById.get(roleId) || { id: roleId, name: roleId };
    if (!Array.isArray(userList)) continue;

    for (const item of userList) {
      if (!item || !item.ucid) continue;
      const ucid = String(item.ucid).trim();
      const name = item.user?.name || item.name || '';
      const userExpireDate = item.expireDate;

      // 1. 维护 ucid -> 用户与角色列表
      if (!ucidToUser.has(ucid)) {
        ucidToUser.set(ucid, {
          user: { ucid, name },
          roles: []
        });
      }
      const ucidEntry = ucidToUser.get(ucid);
      if (name && !ucidEntry.user.name) {
        ucidEntry.user.name = name;
      }

      const existingRole = ucidEntry.roles.find(r => r.id === roleId);
      if (!existingRole) {
        ucidEntry.roles.push({
          id: roleMeta.id,
          name: roleMeta.name || roleMeta.id,
          active: roleMeta.active,
          expireDate: roleMeta.expireDate,
          userExpireDate
        });
      }

      // 2. 维护 name -> 用户候选列表（用于同名消歧）
      if (name) {
        if (!nameToUsers.has(name)) {
          nameToUsers.set(name, []);
        }
        const nameList = nameToUsers.get(name);
        let candidate = nameList.find(c => c.ucid === ucid);
        if (!candidate) {
          candidate = { ucid, name, roles: [] };
          nameList.push(candidate);
        }
        if (!candidate.roles.includes(roleId)) {
          candidate.roles.push(roleId);
        }
      }
    }
  }

  return { ucidToUser, nameToUsers };
}

/**
 * 从内存索引解析人员标识（工号或姓名），自动处理同名消歧
 * @param {string} identifier 工号（UCID）或姓名
 * @param {{ ucidToUser: Map, nameToUsers: Map }} memoryIndex 内存双向索引
 * @returns {Object} 匹配结果
 */
export function resolveUserFromIndex(identifier, memoryIndex) {
  if (!memoryIndex) {
    return { notFound: true, identifier };
  }
  const idStr = String(identifier || '').trim();
  if (!idStr) {
    return { notFound: true, identifier: '' };
  }

  const { ucidToUser, nameToUsers } = memoryIndex;

  // 1. 优先按工号精确匹配
  if (ucidToUser && ucidToUser.has(idStr)) {
    const entry = ucidToUser.get(idStr);
    return {
      matched: true,
      user: { ...entry.user },
      roles: entry.roles.slice()
    };
  }

  // 2. 按姓名匹配
  if (nameToUsers && nameToUsers.has(idStr)) {
    const candidates = nameToUsers.get(idStr);
    if (candidates.length === 1) {
      const ucid = candidates[0].ucid;
      const entry = ucidToUser ? ucidToUser.get(ucid) : null;
      if (entry) {
        return {
          matched: true,
          user: { ...entry.user },
          roles: entry.roles.slice()
        };
      }
    } else if (candidates.length > 1) {
      return {
        ambiguous: true,
        query: idStr,
        candidates: candidates.map(c => ({
          ucid: c.ucid,
          name: c.name,
          roles: c.roles.slice()
        }))
      };
    }
  }

  return { notFound: true, identifier: idStr };
}

/**
 * 跨所有有效未过期角色，汇聚单人员工的生效权限画像并对约束取并集
 * @param {{ ucid: string, name?: string }} user 用户信息
 * @param {Array<Object>} [userRoles=[]] 用户绑定的角色摘要列表
 * @param {Map|Object|Array} [allRolesMap=new Map()] 全量角色元数据池
 * @param {Object} [options={}] 参数项
 * @returns {Object} 单人权限画像 UserProfile
 */
export function aggregateEffectivePermissions(user, userRoles = [], allRolesMap = new Map(), options = {}) {
  const appId = options.appId || 'iot_auth';
  const env = options.env || 'test';
  const now = typeof options.now === 'number' ? options.now : Date.now();

  let roleFinder;
  if (allRolesMap instanceof Map) {
    roleFinder = (id) => allRolesMap.get(id);
  } else if (Array.isArray(allRolesMap)) {
    const map = new Map(allRolesMap.map(r => [r.id, r]));
    roleFinder = (id) => map.get(id);
  } else if (allRolesMap && typeof allRolesMap === 'object') {
    roleFinder = (id) => allRolesMap[id];
  } else {
    roleFinder = () => null;
  }

  // 1. 过滤无效/过期角色及失效绑定
  const validRoles = [];
  for (const userRole of userRoles) {
    if (!userRole) continue;
    const roleId = userRole.id || userRole.roleId;
    const fullRole = roleFinder(roleId) || userRole;

    // 状态判定：停用则过滤
    if (userRole.active === false || fullRole.active === false) {
      continue;
    }

    // 角色过期判定
    const roleExpireDate = fullRole.expireDate || userRole.expireDate;
    if (roleExpireDate) {
      const expireTime = new Date(roleExpireDate).getTime();
      if (!Number.isNaN(expireTime) && expireTime <= now) {
        continue;
      }
    }

    // 用户与角色绑定过期判定
    const userExpireDate = userRole.userExpireDate;
    if (userExpireDate) {
      const bindingTime = new Date(userExpireDate).getTime();
      if (!Number.isNaN(bindingTime) && bindingTime <= now) {
        continue;
      }
    }

    validRoles.push({
      id: roleId,
      name: fullRole.name || userRole.name || roleId,
      portalUrl: generatePortalUrl(env, appId, 'role', roleId),
      fullRole
    });
  }

  // 2. 汇聚所有权限点并对 exts 进行 Union 并集合并
  const permsMap = new Map();

  for (const validRole of validRoles) {
    const roleId = validRole.id;
    const rolePerms = validRole.fullRole?.perms || [];

    for (const perm of rolePerms) {
      const permId = perm.permId || perm.id;
      if (!permId) continue;
      const permName = perm.name || perm.permName || permId;

      if (!permsMap.has(permId)) {
        permsMap.set(permId, {
          id: permId,
          name: permName,
          sourceRoles: new Set(),
          portalUrl: generatePortalUrl(env, appId, 'perm', permId),
          extsMap: new Map()
        });
      }

      const permRecord = permsMap.get(permId);
      permRecord.sourceRoles.add(roleId);
      if (permName && permRecord.name === permId) {
        permRecord.name = permName;
      }

      // 提取 exts 并取并集
      if (Array.isArray(perm.exts)) {
        for (const ext of perm.exts) {
          if (!ext || !ext.extId) continue;
          const extId = ext.extId;
          if (!permRecord.extsMap.has(extId)) {
            permRecord.extsMap.set(extId, new Set());
          }
          const valSet = permRecord.extsMap.get(extId);
          const values = Array.isArray(ext.value)
            ? ext.value
            : (ext.value !== undefined && ext.value !== null ? [ext.value] : []);
          for (const v of values) {
            valSet.add(String(v));
          }
        }
      } else if (perm.exts && typeof perm.exts === 'object') {
        for (const [extId, val] of Object.entries(perm.exts)) {
          if (!permRecord.extsMap.has(extId)) {
            permRecord.extsMap.set(extId, new Set());
          }
          const valSet = permRecord.extsMap.get(extId);
          const values = Array.isArray(val)
            ? val
            : (val !== undefined && val !== null ? [val] : []);
          for (const v of values) {
            valSet.add(String(v));
          }
        }
      }
    }
  }

  // 格式化输出 perms
  const perms = [];
  for (const permRecord of permsMap.values()) {
    const extsObj = {};
    for (const [extId, valSet] of permRecord.extsMap.entries()) {
      extsObj[extId] = Array.from(valSet).sort();
    }
    perms.push({
      id: permRecord.id,
      name: permRecord.name,
      sourceRoles: Array.from(permRecord.sourceRoles),
      portalUrl: permRecord.portalUrl,
      exts: extsObj
    });
  }

  return {
    user: {
      ucid: String(user.ucid || ''),
      name: user.name || ''
    },
    appId,
    env,
    roles: validRoles.map(r => ({
      id: r.id,
      name: r.name,
      portalUrl: r.portalUrl
    })),
    perms
  };
}

/**
 * 双人三层递进 Diff 核心算法
 * Tier 1: 角色层差异 (onlyA, onlyB, both)
 * Tier 2: 权限点层差异 (onlyA, onlyB, both)
 * Tier 3: 约束取值差集下探 (constraintDiffs)
 *
 * @param {Object} profileA 用户 A 权限画像
 * @param {Object} profileB 用户 B 权限画像
 * @param {Object} [options={}] 参数项
 * @returns {Object} 双人对比结果 UserDiffResult
 */
export function diffUserProfiles(profileA, profileB, options = {}) {
  const appId = options.appId || profileA?.appId || profileB?.appId || 'iot_auth';
  const env = options.env || profileA?.env || profileB?.env || 'test';

  const userA = profileA?.user || { ucid: '', name: '' };
  const userB = profileB?.user || { ucid: '', name: '' };

  const rolesA = profileA?.roles || [];
  const rolesB = profileB?.roles || [];
  const permsA = profileA?.perms || [];
  const permsB = profileB?.perms || [];

  // ==========================================
  // Tier 1: 角色层 Diff
  // ==========================================
  const rolesA_map = new Map(rolesA.map(r => [r.id, r]));
  const rolesB_map = new Map(rolesB.map(r => [r.id, r]));

  const onlyRolesA = [];
  const onlyRolesB = [];
  const bothRoles = [];

  for (const roleA of rolesA) {
    if (rolesB_map.has(roleA.id)) {
      bothRoles.push({
        id: roleA.id,
        name: roleA.name,
        portalUrl: roleA.portalUrl || generatePortalUrl(env, appId, 'role', roleA.id)
      });
    } else {
      onlyRolesA.push({
        id: roleA.id,
        name: roleA.name,
        portalUrl: roleA.portalUrl || generatePortalUrl(env, appId, 'role', roleA.id)
      });
    }
  }

  for (const roleB of rolesB) {
    if (!rolesA_map.has(roleB.id)) {
      onlyRolesB.push({
        id: roleB.id,
        name: roleB.name,
        portalUrl: roleB.portalUrl || generatePortalUrl(env, appId, 'role', roleB.id)
      });
    }
  }

  // ==========================================
  // Tier 2: 权限点层 Diff
  // ==========================================
  const permsA_map = new Map(permsA.map(p => [p.id, p]));
  const permsB_map = new Map(permsB.map(p => [p.id, p]));

  const onlyPermsA = [];
  const onlyPermsB = [];
  const bothPerms = [];
  const constraintDiffs = [];
  let hasOverallConstraintDiff = false;

  for (const permA of permsA) {
    if (!permsB_map.has(permA.id)) {
      onlyPermsA.push({
        id: permA.id,
        name: permA.name,
        sourceRoles: permA.sourceRoles || [],
        portalUrl: permA.portalUrl || generatePortalUrl(env, appId, 'perm', permA.id),
        exts: permA.exts || {}
      });
    } else {
      const permB = permsB_map.get(permA.id);
      const permId = permA.id;
      const permName = permA.name || permB.name || permId;

      // ==========================================
      // Tier 3: 约束取值差集下探
      // ==========================================
      const extKeysA = Object.keys(permA.exts || {});
      const extKeysB = Object.keys(permB.exts || {});
      const allExtKeys = Array.from(new Set([...extKeysA, ...extKeysB])).sort();

      let permHasScopeDiff = false;
      const permConstraintRows = [];

      for (const extId of allExtKeys) {
        const valuesA = Array.isArray(permA.exts?.[extId]) ? permA.exts[extId] : [];
        const valuesB = Array.isArray(permB.exts?.[extId]) ? permB.exts[extId] : [];
        const setA = new Set(valuesA);
        const setB = new Set(valuesB);

        const onlyInA = valuesA.filter(v => !setB.has(v));
        const onlyInB = valuesB.filter(v => !setA.has(v));

        if (onlyInA.length > 0 || onlyInB.length > 0) {
          permHasScopeDiff = true;
        }

        const extName = EXT_NAMES[extId] || extId;
        const nameA = userA.name || userA.ucid || 'User A';
        const nameB = userB.name || userB.ucid || 'User B';

        let explanation = '';
        if (onlyInA.length > 0 && onlyInB.length === 0) {
          explanation = `${nameB}相比${nameA}缺少${extName}约束: [${onlyInA.join(', ')}]`;
        } else if (onlyInB.length > 0 && onlyInA.length === 0) {
          explanation = `${nameB}相比${nameA}多出${extName}约束: [${onlyInB.join(', ')}]`;
        } else if (onlyInA.length > 0 && onlyInB.length > 0) {
          explanation = `${nameA}独有 [${onlyInA.join(', ')}], ${nameB}独有 [${onlyInB.join(', ')}]`;
        } else {
          explanation = '两者取值一致';
        }

        permConstraintRows.push({
          permId,
          permName,
          extId,
          extName,
          scopeA: valuesA,
          scopeB: valuesB,
          onlyInA,
          onlyInB,
          explanation
        });
      }

      if (permHasScopeDiff) {
        hasOverallConstraintDiff = true;
        constraintDiffs.push(...permConstraintRows);
      }

      bothPerms.push({
        id: permId,
        name: permName,
        hasScopeDiff: permHasScopeDiff,
        portalUrl: permA.portalUrl || generatePortalUrl(env, appId, 'perm', permId)
      });
    }
  }

  for (const permB of permsB) {
    if (!permsA_map.has(permB.id)) {
      onlyPermsB.push({
        id: permB.id,
        name: permB.name,
        sourceRoles: permB.sourceRoles || [],
        portalUrl: permB.portalUrl || generatePortalUrl(env, appId, 'perm', permB.id),
        exts: permB.exts || {}
      });
    }
  }

  const isIdentical = onlyRolesA.length === 0 &&
                      onlyRolesB.length === 0 &&
                      onlyPermsA.length === 0 &&
                      onlyPermsB.length === 0 &&
                      !hasOverallConstraintDiff;

  const summary = {
    isIdentical,
    roleCount: {
      userA: rolesA.length,
      userB: rolesB.length,
      shared: bothRoles.length
    },
    permCount: {
      userA: permsA.length,
      userB: permsB.length,
      shared: bothPerms.length
    },
    hasConstraintDiff: hasOverallConstraintDiff
  };

  return {
    userA,
    userB,
    appId,
    env,
    summary,
    rolesDiff: {
      onlyA: onlyRolesA,
      onlyB: onlyRolesB,
      both: bothRoles
    },
    permsDiff: {
      onlyA: onlyPermsA,
      onlyB: onlyPermsB,
      both: bothPerms
    },
    constraintDiffs
  };
}
