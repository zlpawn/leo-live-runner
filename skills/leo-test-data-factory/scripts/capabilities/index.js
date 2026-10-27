/**
 * 原子能力统一出口
 *
 * 用法：
 *   import { capabilities } from './capabilities/index.js';
 *   const r = await capabilities.house.ensure({...}, ctx);
 */
import * as house from './house.js';
import * as lock from './lock.js';
import * as contract from './contract.js';
import * as equity from './equity.js';
import * as commodity from './commodity.js';
import * as installOrder from './installOrder.js';
import * as managerTask from './managerTask.js';
import * as order from './order.js';
import * as discover from './discover.js';

export const capabilities = {
  house,
  lock,
  contract,
  equity,
  commodity,
  installOrder,
  managerTask,
  order,
  discover
};

export default capabilities;
