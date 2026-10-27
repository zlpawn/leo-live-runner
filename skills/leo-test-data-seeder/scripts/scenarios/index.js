/**
 * 场景注册表
 */
import task1 from './task1-auto-install.js';
import task2 from './task2-sign-install.js';
import task3 from './task3-dispatch.js';
import task4 from './task4-customer-service.js';
import task5 from './task5-low-battery.js';

export const scenarios = {
  'sms-task1-auto-install': task1,
  'sms-task2-sign-install': task2,
  'sms-task3-dispatch': task3,
  'sms-task4-customer-service': task4,
  'sms-task5-low-battery': task5
};

export function getScenario(name) {
  const s = scenarios[name];
  if (!s) {
    throw new Error(`未知场景: ${name}。可用: ${Object.keys(scenarios).join(', ')}`);
  }
  return s;
}

export function listScenarios() {
  return Object.entries(scenarios).map(([name, s]) => ({
    name,
    description: s.description,
    switchKey: s.switchKey || null
  }));
}
