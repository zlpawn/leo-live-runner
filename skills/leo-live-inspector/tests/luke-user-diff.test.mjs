import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUserMemoryIndex,
  resolveUserFromIndex,
  aggregateEffectivePermissions,
  diffUserProfiles,
  generatePortalUrl,
  EXT_NAMES
} from '../scripts/common/luke_diff_core.js';
import {
  EXT_NAMES as LUKE_EXT_NAMES,
  generatePortalUrl as lukeGeneratePortalUrl,
  buildUserMemoryIndex as lukeBuildUserMemoryIndex,
  resolveUserFromIndex as lukeResolveUserFromIndex,
  aggregateEffectivePermissions as lukeAggregateEffectivePermissions,
  diffUserProfiles as lukeDiffUserProfiles,
  drainPages,
  fetchAppRolesWithUsers,
  getUserPermissions,
  compareUserPermissions
} from '../scripts/common/luke.js';

const mockRoles = [
  {
    id: 'anjiah5:inventoryAdmin',
    name: '安家H5-库存管理员',
    active: true,
    expireDate: '2099-12-31T23:59:59.000Z',
    perms: [
      {
        permId: 'anjia:lock:infoView',
        name: '门锁信息查看',
        exts: [
          { extId: 'cityCode', value: ['310000'] },
          { extId: 'apiUrl', value: ['/api/v1/locks/info'] }
        ]
      },
      {
        permId: 'anjia:lock:delete',
        name: '门锁删除',
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
        name: '门锁信息查看',
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
        name: '设备重启',
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
    perms: [{ permId: 'expired:perm', name: '过期权限', exts: [] }]
  },
  {
    id: 'inactive:role',
    name: '停用角色',
    active: false,
    expireDate: '2099-12-31T23:59:59.000Z',
    perms: [{ permId: 'inactive:perm', name: '停用权限', exts: [] }]
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
  ],
  'expired:role': [
    { ucid: '1001', expireDate: '2099-12-31T23:59:59.000Z', user: { name: '张林' } }
  ],
  'inactive:role': [
    { ucid: '1001', expireDate: '2099-12-31T23:59:59.000Z', user: { name: '张林' } }
  ]
};

test('generatePortalUrl formats URLs for test and prod environments', () => {
  assert.equal(
    generatePortalUrl('test', 'iot_auth', 'role', 'anjiah5:inventoryAdmin'),
    'https://test-luke.ke.com/#/role/detail?appId=iot_auth&id=anjiah5:inventoryAdmin'
  );
  assert.equal(
    generatePortalUrl('prod', 'iot_auth', 'perm', 'anjia:lock:infoView'),
    'https://luke.ke.com/#/perm/detail?appId=iot_auth&id=anjia:lock:infoView'
  );
  assert.equal(
    generatePortalUrl('test', 'iot_auth'),
    'https://test-luke.ke.com/#/?appId=iot_auth'
  );
  assert.equal(
    generatePortalUrl('prod', 'iot_auth'),
    'https://luke.ke.com/#/?appId=iot_auth'
  );
});

test('buildUserMemoryIndex & resolveUserFromIndex', () => {
  const index = buildUserMemoryIndex(mockRoles, mockRoleUsersMap);

  // 1. 工号精确匹配
  const byUcid = resolveUserFromIndex('1001', index);
  assert.equal(byUcid.matched, true);
  assert.equal(byUcid.user.name, '张林');
  assert.deepEqual(byUcid.roles.map(r => r.id), [
    'anjiah5:inventoryAdmin',
    'common:employee',
    'expired:role',
    'inactive:role'
  ]);

  // 2. 姓名唯一匹配
  const byName = resolveUserFromIndex('张林', index);
  assert.equal(byName.matched, true);
  assert.equal(byName.user.ucid, '1001');

  // 3. 同名消歧 (王五有 1003 与 1004)
  const ambiguous = resolveUserFromIndex('王五', index);
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.query, '王五');
  assert.equal(ambiguous.candidates.length, 2);
  assert.ok(ambiguous.candidates[0].roles.length > 0);
  assert.ok(ambiguous.candidates[1].roles.length > 0);

  // 4. 未知人员
  const notFound = resolveUserFromIndex('9999', index);
  assert.equal(notFound.notFound, true);
  assert.equal(notFound.identifier, '9999');

  // 5. 空入参保护
  const emptyQuery = resolveUserFromIndex('', index);
  assert.equal(emptyQuery.notFound, true);
});

test('aggregateEffectivePermissions - merges constraints and filters expired / inactive roles', () => {
  const index = buildUserMemoryIndex(mockRoles, mockRoleUsersMap);
  const user1 = resolveUserFromIndex('1001', index);
  const rolesMap = new Map(mockRoles.map(r => [r.id, r]));

  const profile = aggregateEffectivePermissions(user1.user, user1.roles, rolesMap, { appId: 'iot_auth', env: 'test' });
  assert.equal(profile.user.ucid, '1001');
  assert.equal(profile.user.name, '张林');
  assert.equal(profile.appId, 'iot_auth');
  assert.equal(profile.env, 'test');

  // 验证 expired:role 和 inactive:role 被自动剔除，只保留 2 个有效角色
  assert.equal(profile.roles.length, 2);
  assert.deepEqual(profile.roles.map(r => r.id).sort(), ['anjiah5:inventoryAdmin', 'common:employee'].sort());

  // 验证门锁查看权限的约束并集 (310000 + 110000)
  const lockInfoPerm = profile.perms.find(p => p.id === 'anjia:lock:infoView');
  assert.ok(lockInfoPerm);
  assert.equal(lockInfoPerm.name, '门锁信息查看');
  assert.deepEqual(lockInfoPerm.sourceRoles.sort(), ['anjiah5:inventoryAdmin', 'common:employee'].sort());
  assert.deepEqual(lockInfoPerm.exts.cityCode.sort(), ['110000', '310000']);
  assert.deepEqual(lockInfoPerm.exts.apiUrl.sort(), ['/api/v1/locks/detail', '/api/v1/locks/info']);
  assert.ok(lockInfoPerm.portalUrl.includes('test-luke.ke.com'));

  // 验证门锁删除权限
  const deletePerm = profile.perms.find(p => p.id === 'anjia:lock:delete');
  assert.ok(deletePerm);
  assert.deepEqual(deletePerm.sourceRoles, ['anjiah5:inventoryAdmin']);
  assert.deepEqual(deletePerm.exts.apiUrl, ['DELETE /api/v1/locks/:id']);
});

test('aggregateEffectivePermissions - filters expired user bindings', () => {
  const expiredBindingRole = [
    {
      id: 'temp:role',
      name: '临时角色',
      active: true,
      expireDate: '2099-12-31T23:59:59.000Z',
      userExpireDate: '2020-01-01T00:00:00.000Z'
    }
  ];
  const allRolesMap = new Map([
    ['temp:role', {
      id: 'temp:role',
      name: '临时角色',
      active: true,
      expireDate: '2099-12-31T23:59:59.000Z',
      perms: [{ permId: 'temp:perm', exts: [] }]
    }]
  ]);

  const profile = aggregateEffectivePermissions(
    { ucid: '2001', name: '临时用户' },
    expiredBindingRole,
    allRolesMap,
    { appId: 'iot_auth', env: 'test' }
  );

  assert.equal(profile.roles.length, 0);
  assert.equal(profile.perms.length, 0);
});

test('diffUserProfiles - 3-tier deep diff', () => {
  const index = buildUserMemoryIndex(mockRoles, mockRoleUsersMap);
  const rolesMap = new Map(mockRoles.map(r => [r.id, r]));

  const userA = resolveUserFromIndex('1001', index);
  const userB = resolveUserFromIndex('1002', index);

  const profileA = aggregateEffectivePermissions(userA.user, userA.roles, rolesMap, { appId: 'iot_auth', env: 'test' });
  const profileB = aggregateEffectivePermissions(userB.user, userB.roles, rolesMap, { appId: 'iot_auth', env: 'test' });

  const diff = diffUserProfiles(profileA, profileB, { appId: 'iot_auth', env: 'test' });
  assert.equal(diff.summary.isIdentical, false);
  assert.equal(diff.summary.hasConstraintDiff, true);
  assert.equal(diff.summary.roleCount.userA, 2);
  assert.equal(diff.summary.roleCount.userB, 2);
  assert.equal(diff.summary.roleCount.shared, 1);
  assert.equal(diff.summary.permCount.userA, 2);
  assert.equal(diff.summary.permCount.userB, 2);
  assert.equal(diff.summary.permCount.shared, 1);

  // 1. 角色层差异
  assert.deepEqual(diff.rolesDiff.onlyA.map(r => r.id), ['anjiah5:inventoryAdmin']);
  assert.deepEqual(diff.rolesDiff.onlyB.map(r => r.id), ['device:operator']);
  assert.deepEqual(diff.rolesDiff.both.map(r => r.id), ['common:employee']);
  assert.ok(diff.rolesDiff.onlyA[0].portalUrl.includes('test-luke.ke.com'));

  // 2. 权限点层差异
  assert.deepEqual(diff.permsDiff.onlyA.map(p => p.id), ['anjia:lock:delete']);
  assert.deepEqual(diff.permsDiff.onlyB.map(p => p.id), ['anjia:device:reboot']);
  assert.deepEqual(diff.permsDiff.both.map(p => p.id), ['anjia:lock:infoView']);
  assert.equal(diff.permsDiff.both[0].hasScopeDiff, true);

  // 3. 约束下探差异 (User A 相比 User B 在 lock:infoView 约束取值不同)
  assert.ok(diff.constraintDiffs.length > 0);
  const cityDiff = diff.constraintDiffs.find(d => d.extId === 'cityCode');
  assert.ok(cityDiff);
  assert.deepEqual(cityDiff.onlyInA, []);
  assert.deepEqual(cityDiff.onlyInB, []);
  const apiDiff = diff.constraintDiffs.find(d => d.extId === 'apiUrl');
  assert.ok(apiDiff);
  assert.deepEqual(apiDiff.onlyInA, ['/api/v1/locks/info']);
  assert.deepEqual(apiDiff.onlyInB, []);
  assert.ok(apiDiff.explanation.includes('缺少接口路径约束'));
});

test('diffUserProfiles - 100% identical profiles return isIdentical: true', () => {
  const index = buildUserMemoryIndex(mockRoles, mockRoleUsersMap);
  const rolesMap = new Map(mockRoles.map(r => [r.id, r]));

  const userA = resolveUserFromIndex('1001', index);
  const profileA = aggregateEffectivePermissions(userA.user, userA.roles, rolesMap, { appId: 'iot_auth', env: 'test' });

  const diff = diffUserProfiles(profileA, profileA, { appId: 'iot_auth', env: 'test' });
  assert.equal(diff.summary.isIdentical, true);
  assert.equal(diff.summary.hasConstraintDiff, false);
  assert.equal(diff.rolesDiff.onlyA.length, 0);
  assert.equal(diff.rolesDiff.onlyB.length, 0);
  assert.equal(diff.rolesDiff.both.length, profileA.roles.length);
  assert.equal(diff.permsDiff.onlyA.length, 0);
  assert.equal(diff.permsDiff.onlyB.length, 0);
  assert.equal(diff.permsDiff.both.length, profileA.perms.length);
  assert.equal(diff.constraintDiffs.length, 0);
  assert.equal(diff.permsDiff.both[0].hasScopeDiff, false);
});

test('diffUserProfiles - handles empty or asymmetric profiles', () => {
  const profileEmpty = {
    user: { ucid: '0000', name: '无权限用户' },
    appId: 'iot_auth',
    env: 'test',
    roles: [],
    perms: []
  };

  const index = buildUserMemoryIndex(mockRoles, mockRoleUsersMap);
  const rolesMap = new Map(mockRoles.map(r => [r.id, r]));
  const userA = resolveUserFromIndex('1001', index);
  const profileA = aggregateEffectivePermissions(userA.user, userA.roles, rolesMap);

  const diff = diffUserProfiles(profileA, profileEmpty);
  assert.equal(diff.summary.isIdentical, false);
  assert.equal(diff.rolesDiff.onlyA.length, 2);
  assert.equal(diff.rolesDiff.onlyB.length, 0);
  assert.equal(diff.rolesDiff.both.length, 0);
  assert.equal(diff.permsDiff.onlyA.length, 2);
  assert.equal(diff.permsDiff.onlyB.length, 0);
  assert.equal(diff.permsDiff.both.length, 0);
  assert.equal(diff.constraintDiffs.length, 0);
});

test('aggregateEffectivePermissions - accepts array and plain object for allRolesMap', () => {
  const user = { ucid: '8888', name: '测试' };
  const userRoles = [{ id: 'anjiah5:inventoryAdmin', active: true }];

  // Array form
  const profileFromArray = aggregateEffectivePermissions(user, userRoles, mockRoles);
  assert.equal(profileFromArray.roles.length, 1);
  assert.equal(profileFromArray.perms.length, 2);

  // Object form
  const rolesObj = Object.fromEntries(mockRoles.map(r => [r.id, r]));
  const profileFromObj = aggregateEffectivePermissions(user, userRoles, rolesObj);
  assert.equal(profileFromObj.roles.length, 1);
  assert.equal(profileFromObj.perms.length, 2);
});

test('luke.js re-exports all pure calculation functions from luke_diff_core.js', () => {
  assert.equal(typeof LUKE_EXT_NAMES, 'object');
  assert.equal(LUKE_EXT_NAMES.cityCode, EXT_NAMES.cityCode);
  assert.equal(lukeGeneratePortalUrl, generatePortalUrl);
  assert.equal(lukeBuildUserMemoryIndex, buildUserMemoryIndex);
  assert.equal(lukeResolveUserFromIndex, resolveUserFromIndex);
  assert.equal(lukeAggregateEffectivePermissions, aggregateEffectivePermissions);
  assert.equal(lukeDiffUserProfiles, diffUserProfiles);
});

test('luke.js exports network orchestrator functions', () => {
  assert.equal(typeof drainPages, 'function');
  assert.equal(typeof fetchAppRolesWithUsers, 'function');
  assert.equal(typeof getUserPermissions, 'function');
  assert.equal(typeof compareUserPermissions, 'function');
});

test('drainPages - drains multiple pages accurately with pagination helper', async () => {
  const calls = [];
  const mockFetch = async (page) => {
    calls.push(page);
    if (page === 1) return { total: 25, nodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
    if (page === 2) return { total: 25, nodes: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20] };
    return { total: 25, nodes: [21, 22, 23, 24, 25] };
  };

  const all = await drainPages(mockFetch, 10);
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(all.length, 25);
  assert.deepEqual(all, Array.from({ length: 25 }, (_, i) => i + 1));

  // Single page: only calls page 1
  const callsSingle = [];
  const mockFetchSingle = async (page) => {
    callsSingle.push(page);
    return { total: 3, nodes: ['a', 'b', 'c'] };
  };
  const allSingle = await drainPages(mockFetchSingle, 10);
  assert.deepEqual(callsSingle, [1]);
  assert.deepEqual(allSingle, ['a', 'b', 'c']);

  // Empty page: returns empty array
  const allEmpty = await drainPages(async () => ({ total: 0, nodes: [] }), 10);
  assert.deepEqual(allEmpty, []);
});

test('fetchAppRolesWithUsers - page draining and batch concurrency', async () => {
  const mockRoleList = Array.from({ length: 15 }, (_, i) => ({
    id: `role_${i + 1}`,
    name: `Role ${i + 1}`,
    active: true,
    perms: []
  }));

  const mockListRoles = async (appId, { pager }) => {
    const { pageSize, current } = pager;
    const start = (current - 1) * pageSize;
    return {
      total: mockRoleList.length,
      nodes: mockRoleList.slice(start, start + pageSize)
    };
  };

  const mockListRoleUsers = async (appId, roleId, { pager }) => {
    return {
      total: 1,
      nodes: [{ ucid: `user_${roleId}`, user: { name: `User ${roleId}` } }]
    };
  };

  const { allRoles, roleUsersMap } = await fetchAppRolesWithUsers('test_app', {
    pageSize: 10,
    batchSize: 4,
    listRoles: mockListRoles,
    listRoleUsers: mockListRoleUsers
  });

  assert.equal(allRoles.length, 15);
  assert.equal(Object.keys(roleUsersMap).length, 15);
  assert.equal(roleUsersMap['role_1'][0].ucid, 'user_role_1');
  assert.equal(roleUsersMap['role_15'][0].ucid, 'user_role_15');
});

test('getUserPermissions - matched, ambiguous, and notFound handling', async () => {
  const mockListRoles = async () => ({
    total: mockRoles.length,
    nodes: mockRoles
  });
  const mockListRoleUsers = async (appId, roleId) => ({
    total: (mockRoleUsersMap[roleId] || []).length,
    nodes: mockRoleUsersMap[roleId] || []
  });

  const options = {
    listRoles: mockListRoles,
    listRoleUsers: mockListRoleUsers
  };

  // 1. Matched by UCID
  const resUcid = await getUserPermissions('iot_auth', '1001', options);
  assert.equal(resUcid.matched, true);
  assert.equal(resUcid.user.ucid, '1001');
  assert.equal(resUcid.user.name, '张林');
  assert.equal(resUcid.roles.length, 2);
  assert.equal(resUcid.perms.length, 2);

  // 2. Matched by unique name
  const resName = await getUserPermissions('iot_auth', '李四', options);
  assert.equal(resName.matched, true);
  assert.equal(resName.user.ucid, '1002');

  // 3. Ambiguous name
  const resAmb = await getUserPermissions('iot_auth', '王五', options);
  assert.equal(resAmb.ambiguous, true);
  assert.equal(resAmb.query, '王五');
  assert.equal(resAmb.candidates.length, 2);

  // 4. Not found
  const resNotFound = await getUserPermissions('iot_auth', 'nobody', options);
  assert.equal(resNotFound.notFound, true);
  assert.equal(resNotFound.identifier, 'nobody');
});

test('compareUserPermissions - matched diff, ambiguous and notFound handling', async () => {
  const mockListRoles = async () => ({
    total: mockRoles.length,
    nodes: mockRoles
  });
  const mockListRoleUsers = async (appId, roleId) => ({
    total: (mockRoleUsersMap[roleId] || []).length,
    nodes: mockRoleUsersMap[roleId] || []
  });

  const options = {
    listRoles: mockListRoles,
    listRoleUsers: mockListRoleUsers
  };

  // 1. Matched diff
  const diffRes = await compareUserPermissions('iot_auth', '1001', '1002', options);
  assert.equal(diffRes.matched, true);
  assert.equal(diffRes.summary.isIdentical, false);
  assert.equal(diffRes.rolesDiff.onlyA.length, 1);
  assert.equal(diffRes.rolesDiff.onlyB.length, 1);
  assert.equal(diffRes.rolesDiff.both.length, 1);
  assert.equal(diffRes.permsDiff.both.length, 1);

  // 2. userA ambiguous
  const diffAmbA = await compareUserPermissions('iot_auth', '王五', '1001', options);
  assert.equal(diffAmbA.ambiguous, true);
  assert.equal(diffAmbA.target, 'userA');
  assert.equal(diffAmbA.query, '王五');
  assert.equal(diffAmbA.candidates.length, 2);

  // 3. userB ambiguous
  const diffAmbB = await compareUserPermissions('iot_auth', '1001', '王五', options);
  assert.equal(diffAmbB.ambiguous, true);
  assert.equal(diffAmbB.target, 'userB');
  assert.equal(diffAmbB.query, '王五');
  assert.equal(diffAmbB.candidates.length, 2);

  // 4. userA notFound
  const diffNotFoundA = await compareUserPermissions('iot_auth', 'unknownA', '1001', options);
  assert.equal(diffNotFoundA.notFound, true);
  assert.equal(diffNotFoundA.target, 'userA');
  assert.equal(diffNotFoundA.identifier, 'unknownA');

  // 5. userB notFound
  const diffNotFoundB = await compareUserPermissions('iot_auth', '1001', 'unknownB', options);
  assert.equal(diffNotFoundB.notFound, true);
  assert.equal(diffNotFoundB.target, 'userB');
  assert.equal(diffNotFoundB.identifier, 'unknownB');
});


