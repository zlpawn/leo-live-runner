import { requestHttp } from './http.js';
import { loadLukeCookie, saveLukeCookie } from './credentials.js';
import { createCredentialSession, isLoginFailure } from './browser_credentials.js';

export const LUKE_HOSTS = {
  test: 'test-luke.ke.com',
  prod: 'luke.ke.com',
  production: 'luke.ke.com'
};

export const DEFAULT_APP_ID = 'iot_auth';

const isLukeAuthFailure = res => {
  if (isLoginFailure(res)) return true;
  const errors = res?.json?.errors;
  if (Array.isArray(errors)) {
    return errors.some(e => /401|未登录|login|token/i.test(e.message || ''));
  }
  return false;
};

const isLukeSuccess = res => {
  if (!res || !Number.isFinite(res.statusCode) || res.statusCode < 200 || res.statusCode >= 300) return false;
  const errors = res?.json?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    if (errors.some(e => /401|未登录|login|token/i.test(e.message || ''))) return false;
  }
  return true;
};

const credentialSessions = new Map();

function getCredentialSession(env, explicitCookie) {
  const isProd = env === 'prod' || env === 'production';
  const envKey = isProd ? 'prod' : 'test';
  if (explicitCookie) {
    return createCredentialSession({
      load: () => explicitCookie,
      save: () => {},
      explicit: true,
      isAuthFailure: isLukeAuthFailure,
      isSuccess: isLukeSuccess
    });
  }
  let session = credentialSessions.get(envKey);
  if (!session) {
    session = createCredentialSession({
      load: () => loadLukeCookie({ env: envKey }),
      save: cookieStr => saveLukeCookie({ env: envKey, cookieStr }),
      explicit: Boolean(isProd ? process.env.LUKE_PROD_COOKIE : process.env.LUKE_TEST_COOKIE),
      isAuthFailure: isLukeAuthFailure,
      isSuccess: isLukeSuccess,
      names: ['luke-token', 'luke-test-token', 'security_ticket', 'security_ticket_test', 'login_ucid', 'lianjia_uuid', 'lianjia_ssid', 'crosSdkDT2019DeviceId']
    });
    credentialSessions.set(envKey, session);
  }
  return session;
}

/**
 * 执行 Luke GraphQL 请求 (支持测试环境与线上生产环境，自动通过扩展通信自动获取/刷新登录态)
 */
export async function executeLukeGraphQL({
  appId = DEFAULT_APP_ID,
  query,
  variables = {},
  cookie = null,
  setCookie = null,
  env = 'test'
} = {}) {
  const isProd = env === 'prod' || env === 'production';
  const hostname = isProd ? LUKE_HOSTS.prod : LUKE_HOSTS.test;
  const envLabel = isProd ? '线上生产环境 (luke.ke.com)' : '测试环境 (test-luke.ke.com)';

  if (setCookie) {
    saveLukeCookie({ env: isProd ? 'prod' : 'test', cookieStr: setCookie });
  }

  const targetOrigin = `https://${hostname}`;
  const path = `/api/panels/LukePanel/gateway/${appId}/graphql`;
  const postBody = { query, variables };
  const session = getCredentialSession(env, cookie || setCookie);
  const isReadOnly = !/^\s*mutation\b/i.test(query);

  const res = await session.run(`${targetOrigin}${path}`, async (activeCookie) => {
    return requestHttp({
      protocol: 'https:',
      hostname,
      path,
      method: 'POST',
      headers: {
        'Cookie': activeCookie,
        'Content-Type': 'application/json;charset=UTF-8',
        'Accept': 'application/json'
      }
    }, postBody);
  }, { readOnly: isReadOnly });

  if (res.statusCode === 401 || (res.statusCode >= 300 && res.statusCode < 400)) {
    throw new Error(`Luke ${envLabel} 认证失败 (HTTP ${res.statusCode})，登录态已失效，请确认已在 Chrome 登录并启用插件。`);
  }

  if (res.statusCode !== 200) {
    throw new Error(`Luke ${envLabel} GraphQL 请求失败 (HTTP ${res.statusCode}): ${res.raw || res.error || '未知错误'}`);
  }

  const json = res.json || {};
  if (json.errors && json.errors.length > 0) {
    const errorMsgs = json.errors.map(e => e.message).join('; ');
    throw new Error(`Luke ${envLabel} GraphQL 业务错误: ${errorMsgs}`);
  }

  return json.data;
}

// ==================== 约束管理 (Ext) ====================

export async function listExts(appId = DEFAULT_APP_ID, { filter = null, pager = { pageSize: 50, current: 1 }, cookie, env = 'test' } = {}) {
  const query = `
    query ListExts($filter: JSON, $pager: Pagination) {
      allExts(filter: $filter, pager: $pager) {
        total
        nodes {
          id
          name
          isVariable
          kind
          reference
          updateDate
          choices {
            id
            name
          }
        }
      }
    }
  `;
  const data = await executeLukeGraphQL({ appId, query, variables: { filter, pager }, cookie, env });
  return data.allExts;
}

export async function getExt(appId = DEFAULT_APP_ID, extId, { cookie, env = 'test' } = {}) {
  const query = `
    query GetExt($id: ID!) {
      ext(id: $id) {
        id
        name
        isVariable
        kind
        reference
        updateDate
        choices {
          id
          name
        }
      }
    }
  `;
  const data = await executeLukeGraphQL({ appId, query, variables: { id: extId }, cookie, env });
  return data.ext;
}

export async function createExt(appId = DEFAULT_APP_ID, input, { cookie, env = 'test' } = {}) {
  const query = `
    mutation CreateExt($input: ExtInput!) {
      createExt(input: $input) {
        id
        name
      }
    }
  `;
  const data = await executeLukeGraphQL({ appId, query, variables: { input }, cookie, env });
  return data.createExt;
}

export async function updateExt(appId = DEFAULT_APP_ID, input, { cookie, env = 'test' } = {}) {
  const query = `
    mutation UpdateExt($input: ExtInput!) {
      updateExt(input: $input) {
        id
        name
      }
    }
  `;
  const data = await executeLukeGraphQL({ appId, query, variables: { input }, cookie, env });
  return data.updateExt;
}

export async function deleteExt(appId = DEFAULT_APP_ID, extId, { cookie, env = 'test' } = {}) {
  const query = `
    mutation DeleteExt($id: ID!) {
      deleteExt(id: $id)
    }
  `;
  const data = await executeLukeGraphQL({ appId, query, variables: { id: extId }, cookie, env });
  return data.deleteExt;
}

export async function listExtTypes(appId = DEFAULT_APP_ID, { cookie, env = 'test' } = {}) {
  const query = `
    query ListExtTypes {
      allExtTypes {
        total
        nodes {
          code
          name
          nums
        }
      }
    }
  `;
  const data = await executeLukeGraphQL({ appId, query, cookie, env });
  return data.allExtTypes;
}

export async function listExtTypeValues(appId = DEFAULT_APP_ID, code, { pager = { pageSize: 50, current: 1 }, sug, cookie, env = 'test' } = {}) {
  const query = `
    query ListExtTypeValues($code: String!, $pager: Pagination, $sug: String) {
      allExtTypeValues(code: $code, pager: $pager, sug: $sug) {
        total
        nodes {
          code
          value
          name
          remark
        }
      }
    }
  `;
  const data = await executeLukeGraphQL({ appId, query, variables: { code, pager, sug }, cookie, env });
  return data.allExtTypeValues;
}

// ==================== 权限点管理 (Perm) ====================

export async function listPerms(appId = DEFAULT_APP_ID, { filter = null, pager = { pageSize: 20, current: 1 }, cookie, env = 'test' } = {}) {
  const query = `
    query ListPerms($filter: JSON, $pager: Pagination) {
      allPerms(filter: $filter, pager: $pager) {
        total
        nodes {
          id
          name
          desc
          attachedExts {
            id
            required
            multiple
            defaultValue
          }
          excludeIds
          createDate
        }
      }
    }
  `;
  const data = await executeLukeGraphQL({ appId, query, variables: { filter, pager }, cookie, env });
  return data.allPerms;
}

export async function getPerm(appId = DEFAULT_APP_ID, permId, { cookie, env = 'test' } = {}) {
  const query = `
    query GetPerm($permId: ID!) {
      perm(id: $permId) {
        id
        name
        desc
        attachedExts {
          id
          required
          multiple
          defaultValue
        }
        excludeIds
        createDate
        security {
          action
          level
          isSensitive
        }
      }
    }
  `;
  const data = await executeLukeGraphQL({ appId, query, variables: { permId }, cookie, env });
  return data.perm;
}

export async function createPerm(appId = DEFAULT_APP_ID, input, { cookie, env = 'test' } = {}) {
  const query = `
    mutation CreatePerm($input: PermInput!) {
      createPerm(input: $input) {
        id
        name
      }
    }
  `;
  const data = await executeLukeGraphQL({ appId, query, variables: { input }, cookie, env });
  return data.createPerm;
}

export async function updatePerm(appId = DEFAULT_APP_ID, input, { cookie, env = 'test' } = {}) {
  const query = `
    mutation UpdatePerm($perm: PermInput!) {
      updatePerm(input: $perm) {
        id
      }
    }
  `;
  const data = await executeLukeGraphQL({ appId, query, variables: { perm: input }, cookie, env });
  return data.updatePerm;
}

export async function deletePerm(appId = DEFAULT_APP_ID, permId, { cookie, env = 'test' } = {}) {
  const query = `
    mutation DeletePerm($id: ID!) {
      deletePerm(id: $id)
    }
  `;
  const data = await executeLukeGraphQL({ appId, query, variables: { id: permId }, cookie, env });
  return data.deletePerm;
}

// ==================== 角色管理 (Role) ====================

export async function listRoles(appId = DEFAULT_APP_ID, { filter = null, pager = { pageSize: 20, current: 1 }, keyword, cookie, env = 'test' } = {}) {
  const query = `
    query ListRoles($filter: JSON, $pager: Pagination, $keyword: String) {
      allRoles(filter: $filter, pager: $pager, keyword: $keyword) {
        total
        nodes {
          id
          name
          name_en
          desc
          active
          permNums
          childRoleNums
          updateDate
          expireDate
        }
      }
    }
  `;
  const data = await executeLukeGraphQL({ appId, query, variables: { filter, pager, keyword }, cookie, env });
  return data.allRoles;
}

export async function getRole(appId = DEFAULT_APP_ID, roleId, { cookie, env = 'test' } = {}) {
  const query = `
    query GetRole($roleId: ID!) {
      role(id: $roleId) {
        id
        name
        name_en
        desc
        active
        permNums
        childRoleNums
        perms {
          permId
          exts {
            extId
            value
          }
        }
      }
    }
  `;
  const data = await executeLukeGraphQL({ appId, query, variables: { roleId }, cookie, env });
  return data.role;
}

export async function createRole(appId = DEFAULT_APP_ID, input, { cookie, env = 'test' } = {}) {
  const query = `
    mutation CreateRole($input: RoleInput!) {
      createRole(input: $input) {
        id
        name
      }
    }
  `;
  const data = await executeLukeGraphQL({ appId, query, variables: { input }, cookie, env });
  return data.createRole;
}

export async function updateRole(appId = DEFAULT_APP_ID, input, { cookie, env = 'test' } = {}) {
  const query = `
    mutation UpdateRole($role: RoleInput!) {
      updateRole(input: $role) {
        id
      }
    }
  `;
  const data = await executeLukeGraphQL({ appId, query, variables: { role: input }, cookie, env });
  return data.updateRole;
}

export async function updateRolePerms(appId = DEFAULT_APP_ID, roleId, perms = [], childRoles = [], { cookie, env = 'test' } = {}) {
  const query = `
    mutation UpdateRolePerms($id: ID!, $perms: [RolePermInput!], $childRoles: [String]) {
      updateRolePerms(id: $id, perms: $perms, childRoles: $childRoles) {
        id
      }
    }
  `;
  const data = await executeLukeGraphQL({ appId, query, variables: { id: roleId, perms, childRoles }, cookie, env });
  return data.updateRolePerms;
}

export async function deleteRole(appId = DEFAULT_APP_ID, roleId, { cookie, env = 'test' } = {}) {
  const query = `
    mutation DeleteRole($id: ID!) {
      deleteRole(id: $id)
    }
  `;
  const data = await executeLukeGraphQL({ appId, query, variables: { id: roleId }, cookie, env });
  return data.deleteRole;
}

// ==================== 角色人员绑定 (Role Users) ====================

export async function listRoleUsers(appId = DEFAULT_APP_ID, roleId, { pager = { pageSize: 50, current: 1 }, cookie, env = 'test' } = {}) {
  const query = `
    query ListRoleUsers($roleId: ID!, $pager: Pagination) {
      allRoleUsers(roleId: $roleId, pager: $pager) {
        total
        nodes {
          ucid
          expireDate
          user {
            name
          }
        }
      }
    }
  `;
  const data = await executeLukeGraphQL({ appId, query, variables: { roleId, pager }, cookie, env });
  return data.allRoleUsers;
}

export async function createRoleUsers(appId = DEFAULT_APP_ID, roleId, ucids = [], { duration = 0, expireDate = null, cookie, env = 'test' } = {}) {
  const query = `
    mutation CreateRoleUsers($roleId: ID!, $ucids: [ID!]!, $duration: Int, $expireDate: DateTime) {
      createRoleUsers(roleId: $roleId, ucids: $ucids, duration: $duration, expireDate: $expireDate)
    }
  `;
  const data = await executeLukeGraphQL({ appId, query, variables: { roleId, ucids, duration, expireDate }, cookie, env });
  return data.createRoleUsers;
}

export async function deleteRoleUsers(appId = DEFAULT_APP_ID, roleId, ucids = [], { cookie, env = 'test' } = {}) {
  const query = `
    mutation DeleteRoleUsers($roleId: ID!, $ucids: [ID!]!) {
      deleteRoleUsers(roleId: $roleId, ucids: $ucids)
    }
  `;
  const data = await executeLukeGraphQL({ appId, query, variables: { roleId, ucids }, cookie, env });
  return data.deleteRoleUsers;
}
