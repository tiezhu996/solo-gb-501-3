/** 修复验证脚本：正常日期 / 非法日期 / 有效期边界 / 原有三条流程 */
'use strict';
const BASE = process.env.BASE || 'http://localhost:18080';
const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 864e5).toISOString().slice(0, 10);

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const mkPerson = async (empNo, name) =>
  (await api('POST', '/api/persons', { empNo, name, team: '验证班' })).data.id;
const mkBatch = async (batchNo, processId, operatorId, reviewerId) =>
  (await api('POST', '/api/batches', { batchNo, processId, operatorId, reviewerId })).data.id;

(async () => {
  console.log('== A. 正常日期 ==');
  const pA = await mkPerson('E2001', '孙八');
  let r = await api('POST', '/api/qualifications', { personId: pA, processId: 'PC003', certName: '目检上岗证', trainedAt: '2026-03-01', validUntil: '2027-03-01' });
  check('正常日期发证 201', r.status === 201, JSON.stringify(r.data));
  const bA = await mkBatch('LOT-V-01', 'PC003', pA);
  r = await api('POST', `/api/batches/${bA}/start`);
  check('正常日期资质开工 200', r.status === 200, JSON.stringify(r.data.reasons || r.data));

  console.log('== B. 非法日期（写入端拒绝 + 存量脏数据拦截） ==');
  const pB = await mkPerson('E2002', '周九');
  for (const [name, patch] of [
    ['trainedAt 为汉字', { trainedAt: '不是日期', validUntil: '2027-01-01' }],
    ['validUntil 为汉字', { trainedAt: '2026-01-01', validUntil: '永久有效' }],
    ['不存在的日历日 2026-02-30', { trainedAt: '2026-01-01', validUntil: '2026-02-30' }],
    ['非零填充 2026-1-5', { trainedAt: '2026-1-5', validUntil: '2027-01-01' }],
    ['月份越界 2026-13-01', { trainedAt: '2026-13-01', validUntil: '2027-01-01' }],
  ]) {
    r = await api('POST', '/api/qualifications', { personId: pB, processId: 'PC003', certName: '目检上岗证', ...patch });
    check(`发证拒绝：${name}`, r.status === 400, `got ${r.status}`);
  }
  r = await api('POST', '/api/qualifications', { personId: pB, processId: 'PC003', certName: '目检上岗证', trainedAt: 20260101, validUntil: '2027-01-01' });
  check('发证拒绝：trainedAt 为数字', r.status === 400, `got ${r.status}`);
  r = await api('PATCH', '/api/qualifications/Q001', { action: 'renew', validUntil: 'forever' });
  check('续期拒绝：validUntil 非法', r.status === 400, `got ${r.status}`);
  // 存量脏数据（修复前写入的 Q006「永久有效」）在校验端必须被拦
  const bBad = await mkBatch('LOT-V-BAD', 'PC001', 'P005', 'P002');
  r = await api('POST', `/api/batches/${bBad}/start`);
  check('存量脏数据资质开工被拦 409', r.status === 409, `got ${r.status}`);
  check('拦截原因指明日期无效', (r.data.reasons || []).some((x) => x.includes('日期数据无效')), JSON.stringify(r.data.reasons));

  console.log('== C. 有效期边界 ==');
  const pC1 = await mkPerson('E2003', '吴十');
  r = await api('POST', '/api/qualifications', { personId: pC1, processId: 'PC003', certName: '目检上岗证', trainedAt: '2026-01-01', validUntil: TODAY });
  check('validUntil=今天 发证 201', r.status === 201, JSON.stringify(r.data));
  const bC1 = await mkBatch('LOT-V-02', 'PC003', pC1);
  r = await api('POST', `/api/batches/${bC1}/start`);
  check('validUntil=今天 当日仍可开工', r.status === 200, JSON.stringify(r.data.reasons || r.data));
  const pC2 = await mkPerson('E2004', '郑一');
  r = await api('POST', '/api/qualifications', { personId: pC2, processId: 'PC003', certName: '目检上岗证', trainedAt: '2025-01-01', validUntil: YESTERDAY });
  check('validUntil=昨天 发证 201（日期合法但已过期）', r.status === 201, JSON.stringify(r.data));
  const bC2 = await mkBatch('LOT-V-03', 'PC003', pC2);
  r = await api('POST', `/api/batches/${bC2}/start`);
  check('validUntil=昨天 开工被拦 409 且原因为过期', r.status === 409 && (r.data.reasons || []).some((x) => x.includes('已过期')), JSON.stringify(r.data));
  const pC3 = await mkPerson('E2005', '冯二');
  r = await api('POST', '/api/qualifications', { personId: pC3, processId: 'PC003', certName: '目检上岗证', trainedAt: '2026-05-01', validUntil: '2026-05-01' });
  check('trainedAt=validUntil 拒绝', r.status === 400, `got ${r.status}`);
  r = await api('POST', '/api/qualifications', { personId: pC3, processId: 'PC003', certName: '目检上岗证', trainedAt: '2026-05-02', validUntil: '2026-05-01' });
  check('validUntil<trainedAt 拒绝', r.status === 400, `got ${r.status}`);

  console.log('== D. 原有三条流程回归 ==');
  // D1 正常授权 + 双人复核
  const bD1 = await mkBatch('LOT-R-01', 'PC001', 'P001', 'P002');
  r = await api('POST', `/api/batches/${bD1}/check`);
  check('预检通过（操作+复核双人）', r.data.pass === true && r.data.items.length === 2);
  r = await api('POST', `/api/batches/${bD1}/start`);
  check('正常开工 200 并冻结授权快照', r.status === 200 && r.data.batch.authorization.operator.qualificationId === 'Q001');
  // D2 拦截矩阵
  const blocks = [
    ['人员停用（赵六）', 'B003', '已停用'],
    ['资质停用+工序不匹配（张三/李四 灭菌）', 'B004', '已停用'],
    ['工序不匹配（李四 目检）', 'B005', '不匹配'],
    ['操作复核同人', 'B006', '不能为同一人'],
  ];
  for (const [name, bid, kw] of blocks) {
    r = await api('POST', `/api/batches/${bid}/start`);
    check(`拦截：${name}`, r.status === 409 && (r.data.reasons || []).some((x) => x.includes(kw)), `got ${r.status} ${JSON.stringify(r.data.reasons || '')}`);
  }
  r = await api('POST', `/api/batches/${bC2}/start`);
  check('拦截：资质过期', r.status === 409 && r.data.reasons.some((x) => x.includes('已过期')));
  // D3 资质变更留痕 + 快照不变
  const before = (await api('GET', '/api/qualifications/Q003/history')).data.length;
  r = await api('PATCH', '/api/qualifications/Q003', { action: 'renew', validUntil: '2028-06-30', reason: '再次续期', changedBy: 'verify' });
  check('续期成功且版本递增', r.status === 200 && r.data.version >= 3, JSON.stringify(r.data));
  const after = (await api('GET', '/api/qualifications/Q003/history')).data;
  check('变更历史新增一条 renew', after.length === before + 1 && after[after.length - 1].changeType === 'renew');
  r = await api('GET', '/api/batches/B002/authorization');
  check('B002 回看仍为当时 v2 快照', r.data.operator && r.data.operator.qualificationVersion === 2, JSON.stringify(r.data));
  r = await api('GET', '/api/batches/B001/authorization');
  check('B001 回看仍为当时 v1 快照', r.data.operator && r.data.operator.qualificationVersion === 1, JSON.stringify(r.data));

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('验证脚本异常：', e); process.exit(1); });
