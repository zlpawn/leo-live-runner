#!/usr/bin/env node
/**
 * 只读体检：验证 skill 能连上各系统并正确发现可用数据
 *
 * 用法：
 *   node scripts/verify.js
 *
 * 零配置——连接信息与密码已内置在 resources/systems.json。
 * 只读，不写任何数据。
 */
import { createContext } from './common/systems.js';
import { capabilities } from './capabilities/index.js';

const ctx = createContext({ mode: 'readonly' });

function line(label, ok, detail = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ': ' + detail : ''}`);
}

async function main() {
  console.log('=== 测试数据构造 Skill 只读体检 ===\n');

  console.log('[1] discover.findContractWithUsableEquity(lock_install)');
  const found = await capabilities.discover.findContractWithUsableEquity(
    { templateCode: 'lock_install', workOrderType: 'INS', limit: 3 }, ctx
  );
  if (!found.ok) {
    line('自动发现', false, `[${found.reason}] ${found.message}`);
    return;
  }
  const h = found.handle;
  line('自动发现', true, `${found.candidates.length + 1} 个可用组合`);
  console.log(`      合同: ${h.contractCode} (id=${h.contractId})`);
  console.log(`      房源: ${h.houseId}  城市: ${h.cityCode}`);
  console.log(`      权益实例: ${h.templateInstId}`);
  console.log(`      商品: ${h.shelfCode} (${h.commodityName})`);
  console.log(`      白名单: ${h.whitelist.join(', ')}\n`);

  console.log('[2] equity.resolve 复验（带 shelfCode）');
  const eq = await capabilities.equity.resolve({
    contractId: h.contractId, templateCode: 'lock_install',
    cityCode: h.cityCode, shelfCode: h.shelfCode
  }, ctx);
  line('权益白名单校验', eq.ok, `goodsRangeOk=${eq.handle?.meta?.goodsRangeOk}`);

  console.log('\n[3] 反例：故意传一个白名单外的货架码');
  const bad = await capabilities.equity.resolve({
    contractId: h.contractId, templateCode: 'lock_install',
    cityCode: h.cityCode, shelfCode: 'NOT_IN_WHITELIST'
  }, ctx);
  line('正确拦截', !bad.ok, `[${bad.reason}]`);

  console.log('\n[4] discover.findSignInstallCombination（Task 2 前置）');
  const combo = await capabilities.discover.findSignInstallCombination({ limit: 3 }, ctx);
  if (combo.ok) {
    line('组合发现', true, `收房合同 ${combo.handle.inContractCode}`);
    console.log(`      房源: ${combo.handle.houseId}`);
    for (const u of combo.handle.dealUsers) {
      console.log(`      ${u.role}: ${u.dealUserName}`);
    }
  } else {
    line('组合发现', false, `[${combo.reason}] ${combo.message}`);
  }

  console.log('\n[5] discover.findLock（Task 4/5 前置：找可用门锁房源）');
  const lock = await capabilities.discover.findLock({
    manufacturerCode: 'hui_ju', requireNoTenant: true, limit: 3
  }, ctx);
  if (lock.ok) {
    line('门锁发现', true, `${lock.candidates.length + 1} 个候选`);
    console.log(`      房源: ${lock.handle.houseId}  城市: ${lock.handle.cityCode}`);
    console.log(`      门锁: ${lock.handle.lockId}  型号: ${lock.handle.prodType}`);
    console.log(`      电量: ${lock.handle.battery}%  售后厂商: ${lock.handle.afterSaleManufacturerCode}`);
  } else {
    line('门锁发现', false, `[${lock.reason}] ${lock.message}`);
  }

  console.log('\n=== 体检完成 ===');
}

main()
  .catch(e => { console.error('\n体检失败:', e.message); process.exitCode = 1; })
  .finally(async () => { await ctx.systems.closeAll(); });
