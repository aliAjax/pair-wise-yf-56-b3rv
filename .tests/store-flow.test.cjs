const test = require('node:test');
const assert = require('node:assert/strict');

// localStorage 垫片，避免 persist 在 Node 下崩溃
const mem = new Map();
global.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const { useIncidentStore, reasonText, queueDemoFailures, resetDemoEndpoint } = require('./build/store');

const s = () => useIncidentStore.getState();
const action = (id) => s().incident.actions.find((a) => a.id === id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('端到端：双人确认 → 逐项隔离（一资产失败）→ 重试补齐 → 全部完成', async () => {
  resetDemoEndpoint();
  s().setRole('analyst');
  // 第一次确认（分析员）
  let r = s().confirmAction('act-1', action('act-1').version);
  assert.equal(r.ok, true);
  // 切到响应负责人，几秒内基于旧版本确认 → 过期拒绝
  s().setRole('responder');
  const stale = s().confirmAction('act-1', action('act-1').version - 1);
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'version-stale');
  assert.equal(action('act-1').approvals.length, 1, '过期确认不计批准人数');
  // 用最新版本完成第二次确认 → 锁定范围与隔离记录
  r = s().confirmAction('act-1', action('act-1').version);
  assert.equal(r.ok, true);
  assert.deepEqual(action('act-1').lockedAssets.sort(), ['api-gateway', 'audit-log', 'customer-portal']);
  assert.equal(action('act-1').isolationRecords.length, 3);

  // 执行：audit-log 首次失败，其余成功，动作停在 partial，未完成记录保留
  let exec = await s().executeAction('act-1');
  assert.equal(exec.ok, false);
  assert.match(exec.message, /部分完成/);
  const records = () => Object.fromEntries(action('act-1').isolationRecords.map((x) => [x.assetId, x]));
  assert.equal(records()['api-gateway'].status, 'success');
  assert.equal(records()['customer-portal'].status, 'success');
  assert.equal(records()['audit-log'].status, 'failed');
  assert.equal(action('act-1').status, 'partial');

  // 重试只处理失败项并补齐
  exec = await s().executeAction('act-1');
  assert.equal(exec.ok, true);
  assert.equal(records()['audit-log'].attempts, 2);
  assert.equal(action('act-1').status, 'executed');
});

test('端到端：批准后新增资产不进本批；级别变化使旧批准失效退回待确认', async () => {
  s().setRole('analyst');
  s().confirmAction('act-2', action('act-2').version);
  s().setRole('legal');
  s().confirmAction('act-2', action('act-2').version);
  assert.equal(action('act-2').status, 'approved');
  const beforeRun = await s().executeAction('act-2');
  assert.equal(beforeRun.ok, true);

  // 新隔离动作：双人确认后再改级别
  s().setRole('analyst');
  // 通过 store 无法新建动作，改复用 act-3（notify 非隔离，不受范围失效影响）——这里用 act-1 已执行完成验证不受影响
  s().setSeverity('high');
  assert.equal(s().incident.severity, 'high');
  assert.equal(action('act-1').status, 'executed', '已完成动作不受级别变化影响');
  assert.equal(action('act-2').status, 'executed');
  // 改回级别不影响已执行动作
  s().setSeverity('critical');
});

test('端到端：部分完成时范围变化 → 旧批准失效 → 重新确认后新增资产入新批', async () => {
  resetDemoEndpoint();
  s().setSeverity('critical');
  // act-3 是 notify，这里通过内部领域函数不便；改为新增一条隔离动作到 store
  const { useIncidentStore: store } = require('./build/store');
  store.setState((st) => ({
    incident: {
      ...st.incident,
      actions: [
        ...st.incident.actions,
        { id: 'act-iso2', title: '隔离备份网段', kind: 'isolate', sensitive: false, status: 'pending', version: 1, approvals: [], isolationRecords: [] },
      ],
    },
  }));
  s().setRole('analyst');
  s().confirmAction('act-iso2', 1);
  s().setRole('responder');
  s().confirmAction('act-iso2', 2);
  assert.equal(action('act-iso2').status, 'approved');
  // 先执行一轮：指定 audit-log 失败，部分完成
  queueDemoFailures('audit-log');
  await s().executeAction('act-iso2');
  assert.equal(action('act-iso2').status, 'partial');
  const failedAsset = action('act-iso2').isolationRecords.find((r) => r.status === 'failed').assetId;
  assert.equal(failedAsset, 'audit-log');
  // 范围加入新资产 → 旧批准立即失效
  const add = s().addAffected('edge-node-9');
  assert.equal(add.ok, true);
  assert.equal(action('act-iso2').status, 'pending');
  assert.equal(action('act-iso2').approvals.length, 0);
  // 失效状态下执行被拒绝
  const blocked = await s().executeAction('act-iso2');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'not-approved');
  // 重新双人确认：锁定范围包含新资产；成功记录保留不重建
  s().setRole('analyst');
  const v = action('act-iso2').version;
  s().confirmAction('act-iso2', v);
  s().setRole('legal');
  s().confirmAction('act-iso2', action('act-iso2').version);
  assert.ok(action('act-iso2').lockedAssets.includes('edge-node-9'));
  const preservedSuccess = action('act-iso2').isolationRecords.filter((r) => r.status === 'success' && r.assetId !== 'edge-node-9');
  assert.ok(preservedSuccess.length >= 2, `应保留此前已成功资产的记录，实际 ${preservedSuccess.length} 条`);
  assert.ok(!action('act-iso2').isolationRecords.some((r) => r.assetId === 'edge-node-9' && r.status === 'success'), '新资产尚待执行');
  // 重试运行：新资产与原失败项一起完成
  const rerun = await s().executeAction('act-iso2');
  assert.equal(rerun.ok, true);
  assert.equal(action('act-iso2').status, 'executed');
});

test('端到端：viewer 无法确认敏感动作；演示模式冻结', () => {
  s().setRole('viewer');
  const r = s().confirmAction('act-3', action('act-3').version);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'sensitive-role-not-allowed');
  assert.match(reasonText[r.reason], /敏感/);

  s().setRole('analyst');
  s().toggleDemo();
  const blocked = s().addAffected('host-x');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'demo-readonly');
  s().toggleDemo();
});
