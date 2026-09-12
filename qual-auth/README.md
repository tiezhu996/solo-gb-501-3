# 人员资质与关键工序授权模块

面向关键工序的人员资质登记与开班前授权校验。零依赖 Node.js（≥18），REST API + 内置单页应用 + JSON 文件持久化，开箱即跑。

## 启动

```bash
node server.js          # 默认端口 18080，可用 PORT=xxxx 覆盖
```

浏览器访问 <http://localhost:18080>。首次启动写入幂等种子数据（3 工序 / 4 人员 / 5 条资质，含过期、停用、人员停用样例）；已有数据时不会覆盖。数据落盘在 `data/db.json`（原子写入）。

## 业务规则

- 开班前校验：操作人员、复核人员（关键工序强制双人）都必须持有该工序的有效资质。
- 以下情形**阻止开工（HTTP 409）并逐条说明原因**：
  - 资质已过有效期（`validUntil < 今天`）
  - 资质被停用（`suspend`）
  - 人员未取得该工序授权（资质与工序不匹配）
  - 人员本身已停用
  - 操作与复核为同一人
- 资质变更（发证 / 续期 `renew` / 停用 `suspend` / 恢复 `resume`）每次写入历史，版本号递增，附原因、操作人和当时完整快照。
- 开工成功时冻结**授权快照**（人员、资质 ID、版本、当时有效期与状态），此后资质再变更不影响批次回看。

## API

| 方法与路径 | 功能 |
| --- | --- |
| `GET/POST /api/processes` | 工序查询 / 登记 |
| `GET/POST /api/persons`，`PATCH /api/persons/:id` | 人员查询 / 登记 / 停用启用 |
| `GET/POST /api/qualifications`，`PATCH /api/qualifications/:id` | 资质查询 / 发证 / 续期·停用·恢复 |
| `GET /api/qualifications/:id/history` | 单条资质变更历史 |
| `GET /api/qualification-history` | 全部变更历史 |
| `GET/POST /api/batches` | 批次查询 / 创建 |
| `POST /api/batches/:id/check` | 开班前预检（只校验不改状态） |
| `POST /api/batches/:id/start` | 开工：通过则冻结授权快照，失败 409 + 原因 |
| `GET /api/batches/:id/authorization` | 回看批次当时使用的授权快照 |

## 快速验证

```bash
# 正常授权：张三(操作) + 李四(复核) 均有封口密封有效资质
curl -X POST localhost:18080/api/batches -H 'Content-Type: application/json' \
  -d '{"batchNo":"LOT-1","processId":"PC001","operatorId":"P001","reviewerId":"P002"}'
curl -X POST localhost:18080/api/batches/<id>/start        # 200 开工成功

# 被拦截：王五资质已过期 → 409 并说明原因
curl -X POST localhost:18080/api/batches -H 'Content-Type: application/json' \
  -d '{"batchNo":"LOT-2","processId":"PC001","operatorId":"P003","reviewerId":"P002"}'
curl -X POST localhost:18080/api/batches/<id>/start        # 409 资质已过期

# 资质变更：续期后重新开工成功，历史保留两个版本
curl -X PATCH localhost:18080/api/qualifications/Q003 -H 'Content-Type: application/json' \
  -d '{"action":"renew","validUntil":"2027-06-30","reason":"完成复训"}'
curl localhost:18080/api/qualifications/Q003/history       # v1 发证 / v2 续期
curl localhost:18080/api/batches/<id>/authorization        # 回看当时冻结的授权版本
```

页面四个页签对应全部能力：**人员与资质**（登记、发证、续期/停用/恢复、历史）、**工序**、**批次开工**（预检、开工、拦截原因展示）、**授权回看 / 变更历史**。
