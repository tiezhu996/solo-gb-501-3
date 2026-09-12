/**
 * 人员资质与关键工序授权模块
 * 零依赖 Node.js 服务：REST API + 静态页面 + JSON 文件持久化
 *
 * 业务规则：
 *  - 人员存在且状态为「在职(active)」方可上岗；
 *  - 关键工序开工前，操作人员与复核人员都必须持有该工序的有效资质；
 *  - 资质过期、被停用、与工序不匹配，或人员已停用时，阻止开工并逐条说明原因；
 *  - 操作人员与复核人员不得为同一人；
 *  - 资质每次变更（发证/续期/停用/恢复）写入历史，版本号递增；
 *  - 开工成功时冻结「授权快照」，批次可永久回看当时使用的授权版本。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 18080);
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ---------------- 持久化 ---------------- */

function emptyDb() {
  return {
    seq: { person: 0, process: 0, qualification: 0, batch: 0, history: 0, check: 0 },
    persons: [],
    processes: [],
    qualifications: [],
    qualificationHistory: [],
    batches: [],
  };
}

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE); // 原子替换，避免写一半
}

let db = loadDb();

function nextId(kind, prefix) {
  db.seq[kind] += 1;
  return `${prefix}${String(db.seq[kind]).padStart(3, '0')}`;
}

/* ---------------- 种子数据（幂等：仅空库时写入） ---------------- */

function seedIfEmpty() {
  if (db && db.persons.length > 0) return false;
  db = emptyDb();
  const now = new Date().toISOString();

  const pSeal = { id: nextId('process', 'PC'), code: 'SEAL', name: '封口密封', keyLevel: '关键', requireReviewer: true, active: true, createdAt: now };
  const pSter = { id: nextId('process', 'PC'), code: 'STER', name: '灭菌装载', keyLevel: '关键', requireReviewer: true, active: true, createdAt: now };
  const pVi = { id: nextId('process', 'PC'), code: 'VI', name: '目检', keyLevel: '一般', requireReviewer: false, active: true, createdAt: now };
  db.processes.push(pSeal, pSter, pVi);

  const zhang = { id: nextId('person', 'P'), empNo: 'E1001', name: '张三', team: '包装一班', status: 'active', createdAt: now };
  const li = { id: nextId('person', 'P'), empNo: 'E1002', name: '李四', team: '包装一班', status: 'active', createdAt: now };
  const wang = { id: nextId('person', 'P'), empNo: 'E1003', name: '王五', team: '包装二班', status: 'active', createdAt: now };
  const zhao = { id: nextId('person', 'P'), empNo: 'E1004', name: '赵六', team: '包装二班', status: 'disabled', createdAt: now };
  db.persons.push(zhang, li, wang, zhao);

  // 资质：正常 / 已过期 / 已停用 / 人员已停用 四种情形齐备，便于直接演示拦截
  grantQualification(zhang.id, pSeal.id, '封口密封操作上岗证', '2026-01-10', '2027-01-09', 'system');
  grantQualification(li.id, pSeal.id, '封口密封操作上岗证', '2026-02-01', '2027-01-31', 'system');
  grantQualification(wang.id, pSeal.id, '封口密封操作上岗证', '2025-01-05', '2026-01-04', 'system'); // 已过期
  const qSter = grantQualification(zhang.id, pSter.id, '灭菌装载上岗证', '2026-03-01', '2027-02-28', 'system');
  suspendQualification(qSter.id, '设备再验证期间暂停授权', 'system'); // 已停用
  grantQualification(zhao.id, pSeal.id, '封口密封操作上岗证', '2026-05-01', '2027-04-30', 'system'); // 人已停用
  // 注意：李四没有目检(VI)资质 → 用于演示「工序不匹配」

  saveDb();
  return true;
}

/* ---------------- 领域逻辑 ---------------- */

const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();

/**
 * 严格校验 YYYY-MM-DD 且为真实日历日期。
 * 拒绝：非字符串、非零填充（2026-1-5）、不存在的日期（2026-02-30）、越界月份等。
 */
function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (y < 1900 || y > 2200) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function findPerson(id) { return db.persons.find((p) => p.id === id); }
function findProcess(id) { return db.processes.find((p) => p.id === id); }
function findQualification(id) { return db.qualifications.find((q) => q.id === id); }
function findBatch(id) { return db.batches.find((b) => b.id === id); }

function activeQualificationFor(personId, processId) {
  return db.qualifications.find((q) => q.personId === personId && q.processId === processId);
}

function recordHistory(qual, changeType, reason, changedBy) {
  db.qualificationHistory.push({
    id: nextId('history', 'H'),
    qualificationId: qual.id,
    personId: qual.personId,
    processId: qual.processId,
    version: qual.version,
    changeType, // create | renew | suspend | resume
    reason: reason || '',
    snapshot: { ...qual },
    changedBy: changedBy || 'anonymous',
    changedAt: now(),
  });
}

function grantQualification(personId, processId, certName, trainedAt, validUntil, changedBy) {
  const qual = {
    id: nextId('qualification', 'Q'),
    personId, processId, certName,
    trainedAt, validUntil,
    status: 'active',
    version: 1,
    createdAt: now(),
    updatedAt: now(),
  };
  db.qualifications.push(qual);
  recordHistory(qual, 'create', '首次发证', changedBy);
  return qual;
}

function mutateQualification(qual, changeType, patch, reason, changedBy) {
  Object.assign(qual, patch, { version: qual.version + 1, updatedAt: now() });
  recordHistory(qual, changeType, reason, changedBy);
  return qual;
}

function suspendQualification(id, reason, changedBy) {
  const qual = findQualification(id);
  if (!qual) return null;
  return mutateQualification(qual, 'suspend', { status: 'suspended' }, reason, changedBy);
}

/**
 * 开班前资格校验：返回 { ok, reasons[] }
 * 规则逐条判定，所有不满足的原因一次性返回。
 */
function checkPersonForProcess(person, process, roleLabel) {
  const reasons = [];
  if (!person) {
    return { ok: false, reasons: [`${roleLabel}不存在`], qualification: null };
  }
  if (person.status !== 'active') {
    reasons.push(`${roleLabel}${person.name}已停用（人员状态：${person.status}）`);
  }
  const qual = activeQualificationFor(person.id, process.id);
  if (!qual) {
    reasons.push(`${roleLabel}${person.name}未取得工序「${process.name}」的操作授权（资质与工序不匹配）`);
  } else {
    // 兜底：历史脏数据（非法日期）一律视为不可用，阻止开工
    if (!isValidDateStr(qual.trainedAt) || !isValidDateStr(qual.validUntil)) {
      reasons.push(`${roleLabel}${person.name}的「${process.name}」资质日期数据无效（培训日期：${qual.trainedAt}，有效期至：${qual.validUntil}），请更正后重新登记`);
      return { ok: false, reasons, qualification: qual };
    }
    if (qual.status !== 'active') {
      reasons.push(`${roleLabel}${person.name}的「${process.name}」资质已停用（证书：${qual.certName}，版本 v${qual.version}）`);
    }
    if (qual.validUntil < today()) {
      reasons.push(`${roleLabel}${person.name}的「${process.name}」资质已过期（有效期至 ${qual.validUntil}，今天 ${today()}）`);
    }
  }
  return { ok: reasons.length === 0, reasons, qualification: qual };
}

/** 对批次执行完整开班前校验，返回结构化结果（不修改批次状态） */
function runPrecheck(batch) {
  const process = findProcess(batch.processId);
  const operator = findPerson(batch.operatorId);
  const reviewer = findPerson(batch.reviewerId);

  const result = {
    id: nextId('check', 'C'),
    batchId: batch.id,
    checkedAt: now(),
    process: process ? { id: process.id, code: process.code, name: process.name } : null,
    items: [],
    pass: false,
  };

  if (!process) {
    result.items.push({ role: 'process', ok: false, reasons: ['批次关联的工序不存在'] });
    return result;
  }
  if (!process.active) {
    result.items.push({ role: 'process', ok: false, reasons: [`工序「${process.name}」已停用`] });
  }

  const opCheck = checkPersonForProcess(operator, process, '操作人员');
  result.items.push({
    role: 'operator',
    personId: operator ? operator.id : null,
    personName: operator ? operator.name : String(batch.operatorId),
    ok: opCheck.ok,
    reasons: opCheck.reasons,
    qualification: opCheck.qualification ? { ...opCheck.qualification } : null,
  });

  if (process.requireReviewer) {
    const rvCheck = checkPersonForProcess(reviewer, process, '复核人员');
    const reasons = [...rvCheck.reasons];
    if (operator && reviewer && operator.id === reviewer.id) {
      reasons.push('复核人员与操作人员不能为同一人（关键工序须双人复核）');
    }
    result.items.push({
      role: 'reviewer',
      personId: reviewer ? reviewer.id : null,
      personName: reviewer ? reviewer.name : String(batch.reviewerId),
      ok: reasons.length === 0,
      reasons,
      qualification: rvCheck.qualification ? { ...rvCheck.qualification } : null,
    });
  }

  result.pass = result.items.every((it) => it.ok);
  return result;
}

/** 开工成功时冻结授权快照 */
function buildAuthorizationSnapshot(batch, check) {
  const snap = { grantedAt: now(), process: check.process };
  for (const item of check.items) {
    if (item.role !== 'operator' && item.role !== 'reviewer') continue;
    snap[item.role] = {
      personId: item.personId,
      personName: item.personName,
      qualificationId: item.qualification.id,
      qualificationVersion: item.qualification.version,
      certName: item.qualification.certName,
      trainedAt: item.qualification.trainedAt,
      validUntil: item.qualification.validUntil,
      statusAtGrant: item.qualification.status,
    };
  }
  return snap;
}

/* ---------------- HTTP 工具 ---------------- */

function send(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

const badRequest = (res, msg) => send(res, 400, { error: msg });
const notFound = (res, msg) => send(res, 404, { error: msg || '资源不存在' });

/* ---------------- 路由 ---------------- */

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => {
    keys.push(k);
    return '([^/]+)';
  }) + '$');
  routes.push({ method, regex, keys, handler });
}

/* 工序 */
route('GET', '/api/processes', async (req, res) => send(res, 200, db.processes));
route('POST', '/api/processes', async (req, res) => {
  const b = await readBody(req);
  if (!b.code || !b.name) return badRequest(res, 'code 和 name 必填');
  if (db.processes.some((p) => p.code === b.code)) return badRequest(res, `工序代码 ${b.code} 已存在`);
  const p = {
    id: nextId('process', 'PC'), code: b.code, name: b.name,
    keyLevel: b.keyLevel || '关键',
    requireReviewer: b.requireReviewer !== false,
    active: true, createdAt: now(),
  };
  db.processes.push(p); saveDb();
  send(res, 201, p);
});

/* 人员 */
route('GET', '/api/persons', async (req, res) => {
  const list = db.persons.map((p) => ({
    ...p,
    qualifications: db.qualifications.filter((q) => q.personId === p.id),
  }));
  send(res, 200, list);
});
route('POST', '/api/persons', async (req, res) => {
  const b = await readBody(req);
  if (!b.empNo || !b.name) return badRequest(res, 'empNo 和 name 必填');
  if (db.persons.some((p) => p.empNo === b.empNo)) return badRequest(res, `工号 ${b.empNo} 已存在`);
  const p = { id: nextId('person', 'P'), empNo: b.empNo, name: b.name, team: b.team || '', status: 'active', createdAt: now() };
  db.persons.push(p); saveDb();
  send(res, 201, p);
});
route('PATCH', '/api/persons/:id', async (req, res, { id }) => {
  const p = findPerson(id);
  if (!p) return notFound(res, '人员不存在');
  const b = await readBody(req);
  if (b.status !== undefined) {
    if (!['active', 'disabled'].includes(b.status)) return badRequest(res, 'status 只能是 active 或 disabled');
    p.status = b.status;
  }
  if (b.name !== undefined) p.name = b.name;
  if (b.team !== undefined) p.team = b.team;
  saveDb();
  send(res, 200, p);
});

/* 资质 */
route('GET', '/api/qualifications', async (req, res) => send(res, 200, db.qualifications));
route('POST', '/api/qualifications', async (req, res) => {
  const b = await readBody(req);
  const person = findPerson(b.personId);
  const process = findProcess(b.processId);
  if (!person) return badRequest(res, 'personId 无效');
  if (!process) return badRequest(res, 'processId 无效');
  if (!b.certName || !b.trainedAt || !b.validUntil) return badRequest(res, 'certName、trainedAt、validUntil 必填');
  if (!isValidDateStr(b.trainedAt)) return badRequest(res, `trainedAt 不是有效日期（要求 YYYY-MM-DD 且为真实日期）：${b.trainedAt}`);
  if (!isValidDateStr(b.validUntil)) return badRequest(res, `validUntil 不是有效日期（要求 YYYY-MM-DD 且为真实日期）：${b.validUntil}`);
  if (b.validUntil <= b.trainedAt) return badRequest(res, 'validUntil 必须晚于 trainedAt');
  const existing = activeQualificationFor(person.id, process.id);
  if (existing) return badRequest(res, `该人员在此工序已有资质 ${existing.id}（v${existing.version}），请用续期/变更接口`);
  const qual = grantQualification(person.id, process.id, b.certName, b.trainedAt, b.validUntil, b.changedBy);
  saveDb();
  send(res, 201, qual);
});
route('PATCH', '/api/qualifications/:id', async (req, res, { id }) => {
  const qual = findQualification(id);
  if (!qual) return notFound(res, '资质不存在');
  const b = await readBody(req);
  const action = b.action;
  if (!['renew', 'suspend', 'resume'].includes(action)) {
    return badRequest(res, 'action 必须是 renew / suspend / resume');
  }
  if (action === 'renew') {
    if (!b.validUntil) return badRequest(res, '续期必须提供 validUntil');
    if (!isValidDateStr(b.validUntil)) return badRequest(res, `validUntil 不是有效日期（要求 YYYY-MM-DD 且为真实日期）：${b.validUntil}`);
    if (b.trainedAt !== undefined && !isValidDateStr(b.trainedAt)) return badRequest(res, `trainedAt 不是有效日期（要求 YYYY-MM-DD 且为真实日期）：${b.trainedAt}`);
    if (b.validUntil <= today()) return badRequest(res, `续期后的有效期 ${b.validUntil} 必须晚于今天 ${today()}`);
    const trainedAt = b.trainedAt || qual.trainedAt;
    if (isValidDateStr(trainedAt) && b.validUntil <= trainedAt) return badRequest(res, 'validUntil 必须晚于 trainedAt');
    mutateQualification(qual, 'renew',
      { validUntil: b.validUntil, trainedAt: b.trainedAt || qual.trainedAt, status: 'active' },
      b.reason || '到期复训续期', b.changedBy);
  } else if (action === 'suspend') {
    if (qual.status === 'suspended') return badRequest(res, '资质已处于停用状态');
    mutateQualification(qual, 'suspend', { status: 'suspended' }, b.reason || '停用', b.changedBy);
  } else {
    if (qual.status === 'active') return badRequest(res, '资质已处于有效状态');
    if (qual.validUntil < today()) return badRequest(res, `资质已过期（${qual.validUntil}），请先续期再恢复`);
    mutateQualification(qual, 'resume', { status: 'active' }, b.reason || '恢复授权', b.changedBy);
  }
  saveDb();
  send(res, 200, qual);
});
route('GET', '/api/qualifications/:id/history', async (req, res, { id }) => {
  if (!findQualification(id)) return notFound(res, '资质不存在');
  send(res, 200, db.qualificationHistory.filter((h) => h.qualificationId === id));
});
route('GET', '/api/qualification-history', async (req, res) => send(res, 200, db.qualificationHistory));

/* 批次与开工 */
route('GET', '/api/batches', async (req, res) => send(res, 200, db.batches));
route('POST', '/api/batches', async (req, res) => {
  const b = await readBody(req);
  if (!b.batchNo || !b.processId || !b.operatorId) {
    return badRequest(res, 'batchNo、processId、operatorId 必填');
  }
  if (db.batches.some((x) => x.batchNo === b.batchNo)) return badRequest(res, `批号 ${b.batchNo} 已存在`);
  const process = findProcess(b.processId);
  if (!process) return badRequest(res, 'processId 无效');
  if (process.requireReviewer && !b.reviewerId) return badRequest(res, `工序「${process.name}」为关键工序，必须指定复核人员`);
  const batch = {
    id: nextId('batch', 'B'),
    batchNo: b.batchNo,
    processId: b.processId,
    operatorId: b.operatorId,
    reviewerId: b.reviewerId || null,
    status: 'draft',
    checks: [],
    authorization: null,
    createdAt: now(),
    startedAt: null,
  };
  db.batches.push(batch); saveDb();
  send(res, 201, batch);
});
route('GET', '/api/batches/:id', async (req, res, { id }) => {
  const batch = findBatch(id);
  if (!batch) return notFound(res, '批次不存在');
  send(res, 200, batch);
});

/* 开班前预检：只校验、不改动状态，便于页面上先试一遍 */
route('POST', '/api/batches/:id/check', async (req, res, { id }) => {
  const batch = findBatch(id);
  if (!batch) return notFound(res, '批次不存在');
  const check = runPrecheck(batch);
  batch.checks.push(check); saveDb();
  send(res, 200, check);
});

/* 开工：校验不过则 409 并逐条说明原因 */
route('POST', '/api/batches/:id/start', async (req, res, { id }) => {
  const batch = findBatch(id);
  if (!batch) return notFound(res, '批次不存在');
  if (batch.status === 'running') return badRequest(res, '批次已在运行中');
  const check = runPrecheck(batch);
  batch.checks.push(check);
  if (!check.pass) {
    saveDb();
    return send(res, 409, {
      error: '开班前资格校验未通过，已阻止开工',
      batchId: batch.id,
      reasons: check.items.flatMap((it) => it.reasons),
      check,
    });
  }
  batch.status = 'running';
  batch.startedAt = now();
  batch.authorization = buildAuthorizationSnapshot(batch, check);
  saveDb();
  send(res, 200, { message: '校验通过，批次已开工', batch });
});

/* 回看批次当时使用的授权 */
route('GET', '/api/batches/:id/authorization', async (req, res, { id }) => {
  const batch = findBatch(id);
  if (!batch) return notFound(res, '批次不存在');
  if (!batch.authorization) return notFound(res, '批次尚未开工，没有授权快照');
  send(res, 200, { batchId: batch.id, batchNo: batch.batchNo, ...batch.authorization });
});

/* ---------------- 静态页面 ---------------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------------- 启动 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = pathname.match(r.regex);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return await r.handler(req, res, params);
      }
      return notFound(res, `接口不存在：${req.method} ${pathname}`);
    }
    if (req.method === 'GET') return serveStatic(req, res, pathname);
    res.writeHead(405); res.end();
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

const seeded = seedIfEmpty();
server.listen(PORT, () => {
  console.log(`人员资质与关键工序授权模块已启动: http://localhost:${PORT}`);
  console.log(seeded ? '已写入种子数据（3 工序 / 4 人员 / 5 条资质，含过期、停用、人员停用样例）' : '使用已有数据，未重复写入种子');
});
