/**
 * 人员资质与关键工序授权 —— 回归测试套件（node:test）
 *
 * 隔离性：
 *  - 在系统临时目录生成全新数据副本，用 QUAL_AUTH_DATA + 独立端口拉起专属服务实例；
 *  - 正式库 data/db.json 全程不被写入，套件首尾做 SHA-256 比对断言；
 *  - 测试数据（工号/批号）带随机后缀，套件可重复运行，结果一致。
 *
 * 运行：npm test  或  node --test test/
 */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const PROD_DB = path.join(__dirname, '..', 'data', 'db.json');
const PORT = 18500 + (process.pid % 300);
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qual-auth-test-'));
const TMP_DB = path.join(TMP, 'db.json');
const RUN = crypto.randomBytes(3).toString('hex');

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 864e5).toISOString().slice(0, 10);

/* ---------- 测试装置 ---------- */

let server = null;
let prodHashBefore = null;

async function startServer() {
  server = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), QUAL_AUTH_DATA: TMP_DB },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(BASE + '/api/processes');
      if (r.ok) return;
    } catch (e) { /* 尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('测试服务启动超时');
}

async function stopServer() {
  if (!server) return;
  if (server.exitCode !== null) { server = null; return; }
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((r) => server.once('exit', r)),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  server = null;
}

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const mkPerson = async (name) =>
  (await api('POST', '/api/persons', { empNo: `T-${RUN}-${name}`, name, team: '验证班' })).data.id;
const mkBatch = async (tag, processId, operatorId, reviewerId) =>
  (await api('POST', '/api/batches', { batchNo: `T-${RUN}-${tag}`, processId, operatorId, reviewerId })).data.id;
const grant = (personId, processId, patch = {}) =>
  api('POST', '/api/qualifications', {
    personId, processId, certName: '测试上岗证',
    trainedAt: '2026-01-01', validUntil: '2027-01-01', ...patch,
  });
const hashFile = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null);

before(async () => {
  prodHashBefore = hashFile(PROD_DB);
  await startServer();
});

after(async () => {
  await stopServer();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/* ---------- 1. 资质登记 ---------- */

test('资质登记：正常发证 201、版本 v1、历史含 create', async () => {
  const p = await mkPerson('登记-甲');
  const r = await grant(p, 'PC003', { certName: '目检上岗证', trainedAt: '2026-03-01', validUntil: '2027-03-01' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.version, 1);
  assert.equal(r.data.status, 'active');
  const hist = (await api('GET', `/api/qualifications/${r.data.id}/history`)).data;
  assert.equal(hist.length, 1);
  assert.equal(hist[0].changeType, 'create');
});

test('资质登记：同一人员同一工序重复发证拒绝 400', async () => {
  const p = await mkPerson('登记-乙');
  assert.equal((await grant(p, 'PC003')).status, 201);
  const dup = await grant(p, 'PC003');
  assert.equal(dup.status, 400);
  assert.match(dup.data.error, /已有资质/);
});

test('资质登记：缺少必填字段拒绝 400', async () => {
  const p = await mkPerson('登记-丙');
  const r = await api('POST', '/api/qualifications', { personId: p, processId: 'PC003' });
  assert.equal(r.status, 400);
});

/* ---------- 2. 日期格式与顺序边界 ---------- */

test('日期格式：非法输入发证一律 400', async (t) => {
  const cases = [
    ['trainedAt 为汉字', { trainedAt: '不是日期' }],
    ['validUntil 为汉字', { validUntil: '永久有效' }],
    ['不存在的日历日 2026-02-30', { validUntil: '2026-02-30' }],
    ['非零填充 2026-1-5', { trainedAt: '2026-1-5' }],
    ['月份越界 2026-13-01', { trainedAt: '2026-13-01' }],
    ['trainedAt 为数字', { trainedAt: 20260101 }],
    ['trainedAt=validUntil', { trainedAt: '2026-05-01', validUntil: '2026-05-01' }],
    ['validUntil 早于 trainedAt', { trainedAt: '2026-05-02', validUntil: '2026-05-01' }],
  ];
  for (const [name, patch] of cases) {
    await t.test(name, async () => {
      const p = await mkPerson(`日期-${name.slice(0, 6)}`);
      const r = await grant(p, 'PC003', patch);
      assert.equal(r.status, 400, JSON.stringify(r.data));
    });
  }
});

test('日期边界：续期时非法日期拒绝 400', async () => {
  const p = await mkPerson('续期-甲');
  const q = (await grant(p, 'PC003')).data;
  for (const patch of [{ validUntil: 'forever' }, { validUntil: '2027-02-30' }, { validUntil: TODAY }]) {
    const r = await api('PATCH', `/api/qualifications/${q.id}`, { action: 'renew', ...patch });
    assert.equal(r.status, 400, JSON.stringify(patch));
  }
});

test('日期边界：validUntil=今天 当日仍可开工', async () => {
  const p = await mkPerson('边界-今天');
  assert.equal((await grant(p, 'PC003', { validUntil: TODAY })).status, 201);
  const b = await mkBatch('边界-今天', 'PC003', p);
  const r = await api('POST', `/api/batches/${b}/start`);
  assert.equal(r.status, 200, JSON.stringify(r.data.reasons || r.data));
});

test('日期边界：validUntil=昨天 开工被拦且原因为过期', async () => {
  const p = await mkPerson('边界-昨天');
  assert.equal((await grant(p, 'PC003', { trainedAt: '2025-01-01', validUntil: YESTERDAY })).status, 201);
  const b = await mkBatch('边界-昨天', 'PC003', p);
  const r = await api('POST', `/api/batches/${b}/start`);
  assert.equal(r.status, 409);
  assert.ok(r.data.reasons.some((x) => x.includes('已过期')), JSON.stringify(r.data.reasons));
});

/* ---------- 3. 正常开工（双人复核） ---------- */

let normalBatchId = null;

test('正常开工：预检通过、开工 200、冻结授权快照', async () => {
  normalBatchId = await mkBatch('正常', 'PC001', 'P001', 'P002');
  const pre = await api('POST', `/api/batches/${normalBatchId}/check`);
  assert.equal(pre.data.pass, true);
  assert.equal(pre.data.items.length, 2, '关键工序须校验操作+复核两人');
  const r = await api('POST', `/api/batches/${normalBatchId}/start`);
  assert.equal(r.status, 200, JSON.stringify(r.data.reasons || r.data));
  const auth = r.data.batch.authorization;
  assert.equal(r.data.batch.status, 'running');
  assert.equal(auth.operator.qualificationId, 'Q001');
  assert.equal(auth.operator.qualificationVersion, 1);
  assert.equal(auth.reviewer.qualificationId, 'Q002');
  assert.ok(auth.grantedAt);
});

/* ---------- 4. 拦截矩阵 ---------- */

test('拦截：资质过期', async () => {
  const b = await mkBatch('拦-过期', 'PC001', 'P003', 'P002'); // 王五 SEAL 资质已过期
  const r = await api('POST', `/api/batches/${b}/start`);
  assert.equal(r.status, 409);
  assert.ok(r.data.reasons.some((x) => x.includes('已过期')), JSON.stringify(r.data.reasons));
});

test('拦截：资质停用', async () => {
  const b = await mkBatch('拦-停用', 'PC002', 'P001', 'P002'); // 张三 STER 资质已停用
  const r = await api('POST', `/api/batches/${b}/start`);
  assert.equal(r.status, 409);
  assert.ok(r.data.reasons.some((x) => x.includes('已停用')), JSON.stringify(r.data.reasons));
});

test('拦截：人员停用', async () => {
  const b = await mkBatch('拦-人停', 'PC001', 'P004', 'P002'); // 赵六已停用
  const r = await api('POST', `/api/batches/${b}/start`);
  assert.equal(r.status, 409);
  assert.ok(r.data.reasons.some((x) => x.includes('已停用')), JSON.stringify(r.data.reasons));
});

test('拦截：工序不匹配（操作人未取得授权）', async () => {
  const b = await mkBatch('拦-不配', 'PC003', 'P002'); // 李四无目检资质
  const r = await api('POST', `/api/batches/${b}/start`);
  assert.equal(r.status, 409);
  assert.ok(r.data.reasons.some((x) => x.includes('不匹配')), JSON.stringify(r.data.reasons));
});

test('拦截：工序不匹配（复核人未取得授权）', async () => {
  const b = await mkBatch('拦-复不配', 'PC002', 'P001', 'P002'); // 李四无灭菌资质
  const r = await api('POST', `/api/batches/${b}/start`);
  assert.equal(r.status, 409);
  assert.ok(r.data.reasons.some((x) => x.includes('复核人员') && x.includes('不匹配')), JSON.stringify(r.data.reasons));
});

test('拦截：操作与复核为同一人', async () => {
  const b = await mkBatch('拦-同人', 'PC001', 'P001', 'P001');
  const r = await api('POST', `/api/batches/${b}/start`);
  assert.equal(r.status, 409);
  assert.ok(r.data.reasons.some((x) => x.includes('不能为同一人')), JSON.stringify(r.data.reasons));
});

/* ---------- 5. 变更留痕 ---------- */

test('变更留痕：续期版本递增、历史完整、被拦批次可重新开工', async () => {
  const b = await mkBatch('痕-续期', 'PC001', 'P003', 'P002'); // 王五过期，先确认被拦
  assert.equal((await api('POST', `/api/batches/${b}/start`)).status, 409);
  const r = await api('PATCH', '/api/qualifications/Q003', { action: 'renew', validUntil: '2028-06-30', reason: '复训续期', changedBy: 'test' });
  assert.equal(r.status, 200);
  assert.equal(r.data.version, 2);
  const hist = (await api('GET', '/api/qualifications/Q003/history')).data;
  assert.deepEqual(hist.map((h) => h.changeType), ['create', 'renew']);
  assert.equal(hist[1].reason, '复训续期');
  assert.equal(hist[1].snapshot.validUntil, '2028-06-30');
  const again = await api('POST', `/api/batches/${b}/start`);
  assert.equal(again.status, 200);
  assert.equal(again.data.batch.authorization.operator.qualificationVersion, 2);
});

test('变更留痕：停用与恢复均写入历史', async () => {
  const p = await mkPerson('痕-停恢');
  const q = (await grant(p, 'PC003')).data;
  await api('PATCH', `/api/qualifications/${q.id}`, { action: 'suspend', reason: '暂停授权', changedBy: 'test' });
  await api('PATCH', `/api/qualifications/${q.id}`, { action: 'resume', reason: '恢复授权', changedBy: 'test' });
  const hist = (await api('GET', `/api/qualifications/${q.id}/history`)).data;
  assert.deepEqual(hist.map((h) => h.changeType), ['create', 'suspend', 'resume']);
  assert.deepEqual(hist.map((h) => h.version), [1, 2, 3]);
});

/* ---------- 6. 批次授权快照 ---------- */

test('授权快照：资质再变更后，批次回看仍为当时版本', async () => {
  // normalBatchId 开工时 Q001 为 v1；现在把 Q001 续到 v2
  const renew = await api('PATCH', '/api/qualifications/Q001', { action: 'renew', validUntil: '2028-12-31', reason: '提前续期', changedBy: 'test' });
  assert.equal(renew.data.version, 2);
  const r = await api('GET', `/api/batches/${normalBatchId}/authorization`);
  assert.equal(r.status, 200);
  assert.equal(r.data.operator.qualificationVersion, 1, '回看必须冻结在开工时的 v1');
  assert.equal(r.data.operator.validUntil, '2027-01-09');
  assert.equal(r.data.reviewer.qualificationVersion, 1);
});

/* ---------- 7. 存量脏数据（停服注入 → 重启 → 拦截） ---------- */

test('存量脏数据：格式非法与顺序颠倒的资质开班均被拦', async () => {
  await stopServer();
  const tdb = JSON.parse(fs.readFileSync(TMP_DB, 'utf8'));
  tdb.qualifications.push(
    { id: 'Q900', personId: 'P001', processId: 'PC003', certName: '目检上岗证', trainedAt: '2027-06-01', validUntil: '2027-01-01', status: 'active', version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'Q901', personId: 'P002', processId: 'PC003', certName: '目检上岗证', trainedAt: '不是日期', validUntil: '永久有效', status: 'active', version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  );
  fs.writeFileSync(TMP_DB, JSON.stringify(tdb, null, 2));
  await startServer();

  const bOrder = await mkBatch('脏-顺序', 'PC003', 'P001');
  const rOrder = await api('POST', `/api/batches/${bOrder}/start`);
  assert.equal(rOrder.status, 409);
  assert.ok(rOrder.data.reasons.some((x) => x.includes('日期顺序错误')), JSON.stringify(rOrder.data.reasons));

  const bFormat = await mkBatch('脏-格式', 'PC003', 'P002');
  const rFormat = await api('POST', `/api/batches/${bFormat}/start`);
  assert.equal(rFormat.status, 409);
  assert.ok(rFormat.data.reasons.some((x) => x.includes('日期数据无效')), JSON.stringify(rFormat.data.reasons));
});

/* ---------- 8. 隔离性 ---------- */

test('隔离性：正式库 data/db.json 全程零改动', async () => {
  assert.equal(hashFile(PROD_DB), prodHashBefore);
});
