/**
 * 回归验证：在干净副本中运行，不改正式数据，可重复执行。
 *
 * 做法：
 *  1. 在系统临时目录生成全新数据文件，用 QUAL_AUTH_DATA + 独立端口拉起专属服务实例；
 *  2. 全部测试数据通过 API 现场创建（人员/批次号带随机后缀，无唯一性冲突）；
 *  3. 「存量脏数据」用例：停服→往副本库注入非法记录→重启→断言开班被拦（模拟老版本写入的历史数据）；
 *  4. 运行前后对正式库 data/db.json 做哈希比对，断言零改动；
 *  5. 结束清理临时目录。重复运行结果一致。
 */
'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 18200 + (process.pid % 300);
const BASE = `http://localhost:${PORT}`;
const SERVER = path.join(__dirname, 'server.js');
const PROD_DB = path.join(__dirname, 'data', 'db.json');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qual-auth-verify-'));
const TMP_DB = path.join(TMP, 'db.json');
const RUN = crypto.randomBytes(3).toString('hex'); // 本批次测试数据后缀

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 864e5).toISOString().slice(0, 10);

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

let server = null;
async function startServer() {
  server = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), QUAL_AUTH_DATA: TMP_DB },
    stdio: ['ignore', 'pipe', 'pipe'],
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

const mkPerson = async (name) =>
  (await api('POST', '/api/persons', { empNo: `T-${RUN}-${name}`, name, team: '验证班' })).data.id;
const mkBatch = async (tag, processId, operatorId, reviewerId) =>
  (await api('POST', '/api/batches', { batchNo: `T-${RUN}-${tag}`, processId, operatorId, reviewerId })).data.id;
const hashFile = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null);

(async () => {
  const prodHashBefore = hashFile(PROD_DB);
  await startServer();

  console.log('== A. 正常日期 ==');
  const pA = await mkPerson('孙八');
  let r = await api('POST', '/api/qualifications', { personId: pA, processId: 'PC003', certName: '目检上岗证', trainedAt: '2026-03-01', validUntil: '2027-03-01' });
  check('正常日期发证 201', r.status === 201, JSON.stringify(r.data));
  const bA = await mkBatch('A1', 'PC003', pA);
  r = await api('POST', `/api/batches/${bA}/start`);
  check('正常日期资质开工 200', r.status === 200, JSON.stringify(r.data.reasons || r.data));

  console.log('== B. 非法日期与顺序（写入端拒绝） ==');
  const pB = await mkPerson('周九');
  for (const [name, patch] of [
    ['trainedAt 为汉字', { trainedAt: '不是日期', validUntil: '2027-01-01' }],
    ['validUntil 为汉字', { trainedAt: '2026-01-01', validUntil: '永久有效' }],
    ['不存在的日历日 2026-02-30', { trainedAt: '2026-01-01', validUntil: '2026-02-30' }],
    ['非零填充 2026-1-5', { trainedAt: '2026-1-5', validUntil: '2027-01-01' }],
    ['trainedAt 为数字', { trainedAt: 20260101, validUntil: '2027-01-01' }],
    ['trainedAt=validUntil', { trainedAt: '2026-05-01', validUntil: '2026-05-01' }],
    ['validUntil 早于 trainedAt', { trainedAt: '2026-05-02', validUntil: '2026-05-01' }],
  ]) {
    r = await api('POST', '/api/qualifications', { personId: pB, processId: 'PC003', certName: '目检上岗证', ...patch });
    check(`发证拒绝：${name}`, r.status === 400, `got ${r.status}`);
  }
  r = await api('PATCH', '/api/qualifications/Q001', { action: 'renew', validUntil: 'forever' });
  check('续期拒绝：validUntil 非法', r.status === 400, `got ${r.status}`);
  r = await api('PATCH', '/api/qualifications/Q001', { action: 'renew', validUntil: '2027-01-01', trainedAt: '2028-01-01' });
  check('续期拒绝：有效期早于新培训日期', r.status === 400, `got ${r.status}`);

  console.log('== C. 有效期边界 ==');
  const pC1 = await mkPerson('吴十');
  await api('POST', '/api/qualifications', { personId: pC1, processId: 'PC003', certName: '目检上岗证', trainedAt: '2026-01-01', validUntil: TODAY });
  const bC1 = await mkBatch('C1', 'PC003', pC1);
  r = await api('POST', `/api/batches/${bC1}/start`);
  check('validUntil=今天 当日仍可开工', r.status === 200, JSON.stringify(r.data.reasons || r.data));
  const pC2 = await mkPerson('郑一');
  await api('POST', '/api/qualifications', { personId: pC2, processId: 'PC003', certName: '目检上岗证', trainedAt: '2025-01-01', validUntil: YESTERDAY });
  const bC2 = await mkBatch('C2', 'PC003', pC2);
  r = await api('POST', `/api/batches/${bC2}/start`);
  check('validUntil=昨天 开工被拦且原因为过期', r.status === 409 && (r.data.reasons || []).some((x) => x.includes('已过期')), JSON.stringify(r.data));

  console.log('== D. 三条主流程 ==');
  // D1 正常授权 + 双人复核
  const bD1 = await mkBatch('D1', 'PC001', 'P001', 'P002');
  r = await api('POST', `/api/batches/${bD1}/check`);
  check('预检通过（操作+复核双人）', r.data.pass === true && r.data.items.length === 2);
  r = await api('POST', `/api/batches/${bD1}/start`);
  check('正常开工 200 并冻结授权快照', r.status === 200 && r.data.batch.authorization.operator.qualificationId === 'Q001');
  // D2 拦截矩阵
  const bExp = await mkBatch('D2-exp', 'PC001', 'P003', 'P002'); // 王五资质过期
  const bSus = await mkBatch('D2-sus', 'PC002', 'P001', 'P002'); // 张三灭菌资质停用 + 李四不匹配
  const bMis = await mkBatch('D2-mis', 'PC003', 'P002');         // 李四无目检资质
  const bDis = await mkBatch('D2-dis', 'PC001', 'P004', 'P002'); // 赵六人员停用
  const bSame = await mkBatch('D2-same', 'PC001', 'P001', 'P001');
  for (const [name, bid, kw] of [
    ['资质过期', bExp, '已过期'],
    ['资质停用', bSus, '已停用'],
    ['工序不匹配（复核人）', bSus, '不匹配'],
    ['工序不匹配（操作人）', bMis, '不匹配'],
    ['人员停用', bDis, '已停用'],
    ['操作复核同人', bSame, '不能为同一人'],
  ]) {
    r = await api('POST', `/api/batches/${bid}/start`);
    check(`拦截：${name}`, r.status === 409 && (r.data.reasons || []).some((x) => x.includes(kw)), `got ${r.status} ${JSON.stringify(r.data.reasons || '')}`);
  }
  // D3 变更留痕 + 快照不变
  r = await api('PATCH', '/api/qualifications/Q003', { action: 'renew', validUntil: '2028-06-30', reason: '复训续期', changedBy: 'verify' });
  check('过期资质续期后版本递增', r.status === 200 && r.data.version === 2, JSON.stringify(r.data));
  const hist = (await api('GET', '/api/qualifications/Q003/history')).data;
  check('变更历史含发证+续期两条', hist.length === 2 && hist[1].changeType === 'renew');
  const bD3 = await mkBatch('D3', 'PC001', 'P003', 'P002');
  r = await api('POST', `/api/batches/${bD3}/start`);
  check('续期后重新开工 200，快照记录 v2', r.status === 200 && r.data.batch.authorization.operator.qualificationVersion === 2);
  await api('PATCH', '/api/qualifications/Q001', { action: 'renew', validUntil: '2028-12-31', reason: '提前续期', changedBy: 'verify' });
  r = await api('GET', `/api/batches/${bD1}/authorization`);
  check('资质再变更后，原批次回看仍为当时 v1', r.data.operator && r.data.operator.qualificationVersion === 1, JSON.stringify(r.data));

  console.log('== E. 存量脏数据（停服注入 → 重启 → 开班拦截） ==');
  await stopServer();
  const tdb = JSON.parse(fs.readFileSync(TMP_DB, 'utf8'));
  tdb.qualifications.push(
    { id: 'Q900', personId: 'P001', processId: 'PC003', certName: '目检上岗证', trainedAt: '2027-06-01', validUntil: '2027-01-01', status: 'active', version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }, // 顺序颠倒且未过期
    { id: 'Q901', personId: 'P002', processId: 'PC003', certName: '目检上岗证', trainedAt: '不是日期', validUntil: '永久有效', status: 'active', version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }, // 格式非法
  );
  fs.writeFileSync(TMP_DB, JSON.stringify(tdb, null, 2));
  await startServer();
  const bE1 = await mkBatch('E1', 'PC003', 'P001');
  r = await api('POST', `/api/batches/${bE1}/start`);
  check('拦截：有效期早于培训日期（顺序错误）', r.status === 409 && (r.data.reasons || []).some((x) => x.includes('日期顺序错误')), `got ${r.status} ${JSON.stringify(r.data.reasons || '')}`);
  const bE2 = await mkBatch('E2', 'PC003', 'P002');
  r = await api('POST', `/api/batches/${bE2}/start`);
  check('拦截：日期格式非法的存量数据', r.status === 409 && (r.data.reasons || []).some((x) => x.includes('日期数据无效')), `got ${r.status} ${JSON.stringify(r.data.reasons || '')}`);

  console.log('== F. 正式数据零改动 ==');
  await stopServer();
  check('正式库 data/db.json 未被修改', hashFile(PROD_DB) === prodHashBefore);

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n结果：${passed} 通过，${failed} 失败（临时副本 ${TMP} 已清理）`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('验证脚本异常：', e);
  await stopServer();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
