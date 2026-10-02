import assert from 'node:assert/strict'
import {
  adoptConflict,
  commitRevision,
  migrateLegacy,
  newChangeId,
  publishRelease,
  replayPending,
  snapshotOf,
  workingSnapshot,
  type CommitInput,
  type PendingWrite,
  type RevisionDoc,
} from '../src/lib/revision'
import type { GraphNode, Mapping, ReviewItem } from '../src/lib/seed'

const leader = { name: '顾明', role: '课程负责人' as const }
const reviewer = { name: '沈越', role: '院系审阅人' as const }

let passed = 0
function ok(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

// 1) 旧数据升级为首版
let doc: RevisionDoc = migrateLegacy(null, 'seed')
ok('旧数据（种子）兼容升级为第 1 版', () => {
  assert.equal(doc.headRev, 1)
  assert.equal(doc.revisions[0].kind, 'init')
  assert.ok(workingSnapshot(doc).mappings.length >= 11)
})

const legacy = { nodes: workingSnapshot(doc).nodes, mappings: workingSnapshot(doc).mappings, reviewItems: workingSnapshot(doc).reviewItems, revision: 'R9', locked: false }
const docLegacy = migrateLegacy(legacy, 'storage')
ok('缺少修订号的旧存储数据升级为首版，说明中保留原标记', () => {
  assert.equal(docLegacy.headRev, 1)
  assert.match(docLegacy.revisions[0].note, /R9/)
})

// 2) 双方基于 R1 分别编辑“不同项”：后提交自动合用
function commitMapping(d: RevisionDoc, baseRev: number, mapping: Mapping, actor: typeof leader, note: string) {
  const input: CommitInput = { baseRev, changeId: newChangeId(), actor, note, change: { kind: 'mapping-add', mapping } }
  const r = commitRevision(d, input)
  assert.ok(r.ok, 'commit should succeed')
  if (!r.ok) throw new Error('fail')
  return r.doc
}

const m1: Mapping = { id: 'M-T1', source: 'GR-06', target: 'C-101', relation: '支撑', weight: 0.6 }
doc = commitMapping(doc, 1, m1, leader, '负责人补 GR-06 映射')
// 审阅人仍基于 R1 编辑另一条映射
const m2: Mapping = { id: 'M-T2', source: 'GR-01', target: 'C-308', relation: '支撑', weight: 0.5 }
const beforeMerge = doc.headRev
const r2 = commitRevision(doc, { baseRev: 1, changeId: newChangeId(), actor: reviewer, note: '审阅人补 GR-01 映射', change: { kind: 'mapping-add', mapping: m2 } })
assert.ok(r2.ok)
if (r2.ok) doc = r2.doc
ok('未触碰同一项的并行改动直接合用（三路合并）', () => {
  assert.equal(r2.ok && r2.merged, true)
  assert.equal(doc.headRev, beforeMerge + 1)
  const ids = workingSnapshot(doc).mappings.map((m) => m.id)
  assert.ok(ids.includes('M-T1') && ids.includes('M-T2'))
  assert.equal(doc.conflicts.length, 0)
})

// 3) 同一项双方都改过：保留两份，形成冲突；任一方工作快照均不被对方覆盖
const nodeBase = workingSnapshot(doc).nodes.find((n) => n.id === 'C-308')!
const leaderNode: GraphNode = { ...nodeBase, label: '软件工程实践（课改）\nC-308', owner: '顾明 / 教授' }
doc = (() => {
  const r = commitRevision(doc, { baseRev: doc.headRev, changeId: newChangeId(), actor: leader, note: '负责人更新 C-308', change: { kind: 'node-upsert', node: leaderNode } })
  assert.ok(r.ok)
  return r.ok ? r.doc : doc
})()
// 审阅人仍基于合并前的版本号（落后 1 版），改同一节点
const reviewerNode: GraphNode = { ...nodeBase, label: '软件工程实践（认证版）\nC-308', owner: '顾明 / 副教授' }
const conflictBaseRev = doc.headRev - 1
const r3 = commitRevision(doc, { baseRev: conflictBaseRev, changeId: newChangeId(), actor: reviewer, note: '审阅人也更新 C-308', change: { kind: 'node-upsert', node: reviewerNode } })
assert.ok(r3.ok)
if (r3.ok) doc = r3.doc
ok('同一项双方都改过：保留两份来源并标明来源，工作版本保留 head 值', () => {
  assert.equal(r3.ok && r3.conflictedChangeIds.length, 1)
  assert.equal(doc.conflicts.length, 1)
  const c = doc.conflicts[0]
  assert.equal(c.kind, 'node-upsert')
  assert.equal(c.entityId, 'C-308')
  assert.equal(c.head.actor.name, '顾明')
  assert.equal(c.incoming.actor.name, '沈越')
  assert.match(c.incoming.value, /认证版/)
  // 工作快照仍是 head（负责人）的版本，未被覆盖
  const current = workingSnapshot(doc).nodes.find((n) => n.id === 'C-308')!
  assert.match(current.label, /课改/)
})

// 4) 冲突未解决前同一项再改：更新来源而非堆叠
const reviewerNode2: GraphNode = { ...reviewerNode, label: '软件工程实践（认证版 v2）\nC-308' }
doc = (() => {
  const r = commitRevision(doc, { baseRev: doc.headRev, changeId: newChangeId(), actor: reviewer, note: '审阅人修订 C-308 v2', change: { kind: 'node-upsert', node: reviewerNode2 } })
  assert.ok(r.ok)
  return r.ok ? r.doc : doc
})()
ok('冲突未决时同一项再改只刷新来源，不堆叠新冲突', () => {
  assert.equal(doc.conflicts.length, 1)
  assert.match(doc.conflicts[0].incoming.value, /v2/)
})

// 5) 裁决采用后提交版本 -> 新修订
const conflictId = doc.conflicts[0].id
const adopted = adoptConflict(doc, conflictId, 'incoming', reviewer)
assert.ok(adopted.ok && adopted.doc)
doc = adopted.doc!
ok('裁决采用后提交版本产生新修订，冲突标记已解决', () => {
  assert.match(workingSnapshot(doc).nodes.find((n) => n.id === 'C-308')!.label, /v2/)
  assert.equal(doc.conflicts[0].resolved?.variant, 'incoming')
  assert.equal(doc.conflicts[0].resolved?.rev, doc.headRev)
})

// 6) 审阅意见：附议 + 退回；发布只纳入已附议，退回项留在队列
const revItem: ReviewItem = { id: 'REV-X1', courseId: 'C-308', requirementId: 'GR-03', evidence: '迭代评审与需求追踪矩阵记录齐全。', submitter: '软件工程课程组', status: '待审阅', comment: '' }
doc = (() => {
  const r = commitRevision(doc, { baseRev: doc.headRev, changeId: newChangeId(), actor: leader, note: '提交 REV-X1', change: { kind: 'review-submit', review: revItem, note: '补充闭环证据' } })
  assert.ok(r.ok)
  return r.ok ? r.doc : doc
})()
const retItem: ReviewItem = { id: 'REV-X2', courseId: 'C-308', requirementId: 'GR-06', evidence: '数据合规案例，暂无评分记录。', submitter: '软件工程课程组', status: '待审阅', comment: '' }
doc = (() => {
  const r = commitRevision(doc, { baseRev: doc.headRev, changeId: newChangeId(), actor: leader, note: '提交 REV-X2', change: { kind: 'review-submit', review: retItem, note: 'GR-06 证据补充' } })
  assert.ok(r.ok)
  return r.ok ? r.doc : doc
})()
doc = (() => {
  const r = commitRevision(doc, { baseRev: doc.headRev, changeId: newChangeId(), actor: reviewer, note: '附议 X1', change: { kind: 'review-decision', review: revItem, decision: { status: '已附议', comment: '证据充分' } } })
  assert.ok(r.ok)
  return r.ok ? r.doc : doc
})()
doc = (() => {
  const r = commitRevision(doc, { baseRev: doc.headRev, changeId: newChangeId(), actor: reviewer, note: '退回 X2', change: { kind: 'review-decision', review: retItem, decision: { status: '已退回', comment: '补评分记录' } } })
  assert.ok(r.ok)
  return r.ok ? r.doc : doc
})()
const rel = publishRelease(doc, '学期锁版', reviewer)
doc = rel.doc
ok('发布锁版只纳入已采用（附议）项，退回项仍留在工作队列', () => {
  const locked = rel.revision.publishedSnapshot!.reviewItems.map((i) => i.id)
  assert.ok(locked.includes('REV-X1'))
  assert.ok(!locked.includes('REV-X2'))
  // 工作队列里退回项仍在，附议项标记了 lockedRev
  const work = workingSnapshot(doc).reviewItems
  assert.ok(work.some((i) => i.id === 'REV-X2' && i.status === '已退回'))
  assert.equal(work.find((i) => i.id === 'REV-X1')!.lockedRev, doc.headRev)
  assert.equal(doc.lastReleaseRev, doc.headRev)
})

// 7) 旧版可查：R1 与锁版快照均可取回
ok('旧版可查：首版与锁版快照都能按修订号取回', () => {
  assert.ok(snapshotOf(doc, 1))
  const locked = snapshotOf(doc, doc.headRev)
  assert.ok(locked && locked.reviewItems.every((i) => i.status === '已附议'))
})

// 8) 发布后的新修改按新版本保存（不影响锁版）
const m3: Mapping = { id: 'M-T3', source: 'GR-03', target: 'C-101', relation: '支撑', weight: 0.4 }
doc = (() => {
  const r = commitRevision(doc, { baseRev: doc.headRev, changeId: newChangeId(), actor: leader, note: '锁版后新增映射', change: { kind: 'mapping-add', mapping: m3 } })
  assert.ok(r.ok)
  return r.ok ? r.doc : doc
})()
ok('锁版之后的新修改按新版本保存，锁版快照不变', () => {
  const locked = snapshotOf(doc, doc.lastReleaseRev!)
  assert.ok(!locked!.mappings.some((m) => m.id === 'M-T3'))
  assert.ok(workingSnapshot(doc).mappings.some((m) => m.id === 'M-T3'))
})

// 9) 退回项重新提交 -> 回到待审阅
doc = (() => {
  const existing = workingSnapshot(doc).reviewItems.find((i) => i.id === 'REV-X2')!
  const r = commitRevision(doc, {
    baseRev: doc.headRev,
    changeId: newChangeId(),
    actor: leader,
    note: 'X2 补评分记录重提',
    change: { kind: 'review-submit', review: { ...existing, evidence: '数据合规案例并附三次作业评分记录。', status: '待审阅', comment: '', lockedRev: undefined }, note: '补评分记录' },
  })
  assert.ok(r.ok)
  return r.ok ? r.doc : doc
})()
ok('退回项补充证据后可重新提交进入队列', () => {
  const item = workingSnapshot(doc).reviewItems.find((i) => i.id === 'REV-X2')!
  assert.equal(item.status, '待审阅')
  assert.equal(item.comment, '')
})

// 10) 写入失败 -> 按修订号恢复（重放），且不重复生成记录
const targetHead = doc.headRev
const pendingInput: CommitInput = { baseRev: targetHead, changeId: newChangeId(), actor: leader, note: '故障期间提交', change: { kind: 'mapping-add', mapping: { id: 'M-FAIL', source: 'OBJ-01', target: 'C-205', relation: '支撑', weight: 0.3 } } }
const pending: PendingWrite = { opId: newChangeId(), originRev: targetHead, at: new Date().toISOString(), payload: { op: 'commit', input: pendingInput } }
doc = { ...doc, pendingWrites: [...doc.pendingWrites, pending] }
const replay1 = replayPending(doc, pending)
doc = { ...replay1.doc, pendingWrites: replay1.doc.pendingWrites.filter((p) => p.opId !== pending.opId) }
ok('写入失败后按修订号重放恢复，生成缺失修订', () => {
  assert.ok(replay1.revision)
  assert.equal(doc.headRev, targetHead + 1)
  assert.ok(workingSnapshot(doc).mappings.some((m) => m.id === 'M-FAIL'))
})
const replay2 = replayPending(doc, pending)
ok('重复重放（重新打开）不会重复生成记录（changeId 幂等）', () => {
  assert.equal(replay2.skipped, true)
  assert.equal(doc.headRev, targetHead + 1)
  assert.equal(workingSnapshot(doc).mappings.filter((m) => m.id === 'M-FAIL').length, 1)
})

// 11) baseRev 非法时拒绝
ok('所见版本号非法（超前/非正）时拒绝提交', () => {
  const bad1 = commitRevision(doc, { ...pendingInput, baseRev: doc.headRev + 99, changeId: newChangeId() })
  assert.equal(bad1.ok, false)
  const bad2 = commitRevision(doc, { ...pendingInput, baseRev: 0, changeId: newChangeId() })
  assert.equal(bad2.ok, false)
})

// 12) 待恢复的发布操作重放：锁版应被创建；带 walOpId 时重复重放不产生额外修订
const headBeforeRelease = doc.headRev
const releaseWal = newChangeId()
const releasePending: PendingWrite = { opId: newChangeId(), originRev: headBeforeRelease, at: new Date().toISOString(), payload: { op: 'release', note: '恢复的锁版', actor: reviewer, walOpId: releaseWal } }
const relReplay = replayPending(doc, releasePending)
doc = relReplay.doc
ok('待恢复队列中的发布操作可重放为锁版修订', () => {
  assert.ok(relReplay.revision)
  assert.equal(relReplay.revision!.kind, 'release')
  assert.equal(doc.lastReleaseRev, doc.headRev)
})
const relReplayAgain = replayPending(doc, releasePending)
ok('发布重复重放（主写成功仅确认失败）按 WAL 操作号跳过，不重复锁版', () => {
  assert.equal(relReplayAgain.skipped, true)
  assert.equal(relReplayAgain.doc.headRev, headBeforeRelease + 1)
})

// 13) 裁决操作的 WAL 幂等：构造一个冲突，裁决后再次重放应跳过
const conflictNodeBase = workingSnapshot(doc).nodes.find((n) => n.id === 'C-205')!
doc = (() => {
  const r = commitRevision(doc, { baseRev: doc.headRev, changeId: newChangeId(), actor: leader, note: '负责人改 C-205', change: { kind: 'node-upsert', node: { ...conflictNodeBase, label: '数据结构（负责人版）\nC-205' } } })
  assert.ok(r.ok)
  return r.ok ? r.doc : doc
})()
const conflictRevHead = doc.headRev
doc = (() => {
  const r = commitRevision(doc, { baseRev: conflictRevHead - 1, changeId: newChangeId(), actor: reviewer, note: '审阅人改 C-205', change: { kind: 'node-upsert', node: { ...conflictNodeBase, label: '数据结构（审阅版）\nC-205' } } })
  assert.ok(r.ok && r.conflictedChangeIds.length === 1)
  return r.ok ? r.doc : doc
})()
const adoptWal = newChangeId()
const c205Conflict = doc.conflicts.find((c) => c.entityId === 'C-205' && !c.resolved)!
const adoptPending: PendingWrite = { opId: newChangeId(), originRev: doc.headRev, at: new Date().toISOString(), payload: { op: 'adopt', conflictId: c205Conflict.id, variant: 'incoming', actor: reviewer, walOpId: adoptWal } }
const adoptReplay1 = replayPending(doc, adoptPending)
doc = adoptReplay1.doc
ok('待恢复裁决可重放并解决冲突', () => {
  assert.ok(adoptReplay1.revision && !adoptReplay1.skipped)
  assert.match(workingSnapshot(doc).nodes.find((n) => n.id === 'C-205')!.label, /审阅版/)
})
const adoptReplay2 = replayPending(doc, adoptPending)
ok('裁决重复重放按 WAL 操作号跳过，不重复生成修订', () => {
  assert.equal(adoptReplay2.skipped, true)
  assert.equal(adoptReplay2.doc.headRev, adoptReplay1.doc.headRev)
})

console.log(`\n全部 ${passed} 项引擎语义检查通过 ✓`)
