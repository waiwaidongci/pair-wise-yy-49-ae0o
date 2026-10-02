import { seedState } from './seed'
import type { GraphNode, Mapping, ReviewItem } from './seed'

/**
 * 可恢复修订流程核心引擎（纯函数，不涉及存储与 DOM）。
 *
 * 关键概念：
 * - 每次提交（revision/commit）都携带提交者“所见版本” baseRev。
 * - baseRev === 当前 head 时快进；落后时三路合并：
 *   未触碰同一项的改动直接合用；同一项双方都改过则保留两份来源，形成冲突项。
 * - 发布是一条独立的 release 修订，只快照已采用（已附议）的内容；退回项留在工作队列。
 * - 全部修订保存在日志中，旧版可随时查看；按修订号恢复（重放）靠 changeId 幂等去重。
 * - 旧数据没有修订号时，兼容升级为第 1 版。
 */

export type Role = '课程负责人' | '院系审阅人'
export type Actor = { name: string; role: Role }

export type Snapshot = {
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
}

export type ChangeKind = 'node-upsert' | 'mapping-add' | 'review-submit' | 'review-decision'

export type Change = {
  id: string
  kind: ChangeKind
  actor: Actor
  at: string
  /** 该项内容，按 kind 区分；review 类共用 review 字段。 */
  node?: GraphNode
  mapping?: Mapping
  review?: Omit<ReviewItem, 'lockedRev'> & { lockedRev?: number }
  decision?: { status: Extract<ReviewItem['status'], '已附议' | '已退回'>; comment: string }
  note?: string
}

export type Variant = {
  /** 来源修订号；head 变体为当前工作版本的来源，incoming 为本次提交的来源。 */
  rev: number
  actor: Actor
  at: string
  value: string
  changeId: string
}

export type Conflict = {
  id: string
  kind: ChangeKind
  entityId: string
  /** 合并发生时落后方的所见版本。 */
  mergedAtRev: number
  /** 当前工作版本保留值。 */
  head: Variant
  /** 落后方提交值。 */
  incoming: Variant
  resolved?: { rev: number; actor: Actor; at: string; variant: 'head' | 'incoming'; note: string }
}

export type Revision = {
  rev: number
  kind: 'init' | 'commit' | 'release'
  baseRev: number
  actor: Actor | null
  at: string
  note: string
  changeIds: string[]
  /** 提交完成后的工作快照（release 亦保留工作态，便于继续在其上修订）。 */
  workingSnapshot: Snapshot
  /** 仅 release 存在：纳入已采用修改的锁版快照。 */
  publishedSnapshot?: Snapshot
  conflicts: Conflict[]
  /** WAL 操作幂等键（发布/裁决重放时用于跳过已完成记录）。 */
  walOpId?: string
}

export type PendingWrite = {
  opId: string
  /** 记录失败时的 head，按该修订号恢复。 */
  originRev: number
  at: string
  payload:
    | { op: 'commit'; input: CommitInput }
    | { op: 'release'; note: string; actor: Actor; walOpId: string }
    | { op: 'adopt'; conflictId: string; variant: 'head' | 'incoming'; actor: Actor; walOpId: string }
}

export type RevisionDoc = {
  format: 2
  headRev: number
  revisions: Revision[]
  /** 改动目录，自包含历史，支持刷新后按修订号重放与冲突展示。 */
  changes: Record<string, Change>
  /** 未解决冲突（与最新修订 conflicts 中未 resolved 部分一致，冗余便于读取）。 */
  conflicts: Conflict[]
  pendingWrites: PendingWrite[]
  lastReleaseRev: number | null
  /** 不参与修订流程的工作区草稿与图谱布局。 */
  draft: string
  layout: Record<string, { x: number; y: number }>
}

export type CommitInput = {
  baseRev: number
  changeId: string
  actor: Actor
  note?: string
  change: Omit<Change, 'id' | 'actor' | 'at'>
}

export type CommitOutcome =
  | { ok: true; doc: RevisionDoc; revision: Revision; merged: boolean; conflictedChangeIds: string[] }
  | { ok: false; reason: 'bad-base' }

export function snapshotOf(doc: RevisionDoc, rev: number): Snapshot | null {
  const revision = doc.revisions.find((item) => item.rev === rev)
  return revision ? revision.publishedSnapshot ?? revision.workingSnapshot : null
}

/** 某修订是否为锁版发布。 */
export function isRelease(doc: RevisionDoc, rev: number): boolean {
  return doc.revisions.find((item) => item.rev === rev)?.kind === 'release'
}

/** 当前工作快照（发布锁版不改变工作态）。 */
export function workingSnapshot(doc: RevisionDoc): Snapshot {
  return doc.revisions[doc.revisions.length - 1].workingSnapshot
}

export function newChangeId(): string {
  const rand = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  return `CHG-${rand}`
}

export function sameActor(a: Actor, b: Actor): boolean {
  return a.name === b.name && a.role === b.role
}

// ---------------------------------------------------------------------------
// 实体级键：判断两个改动是否落在“同一项”上
// ---------------------------------------------------------------------------

function changeEntityId(change: Pick<Change, 'kind' | 'node' | 'mapping' | 'review'>): string {
  switch (change.kind) {
    case 'node-upsert':
      return change.node!.id
    case 'mapping-add':
      return change.mapping!.id
    case 'review-submit':
    case 'review-decision':
      return change.review!.id
  }
}

function overlaps(a: Change, b: Change): boolean {
  return a.kind === b.kind && changeEntityId(a) === changeEntityId(b)
}

function entityAt(snapshot: Snapshot, kind: ChangeKind, entityId: string): GraphNode | Mapping | ReviewItem | undefined {
  if (kind === 'node-upsert') return snapshot.nodes.find((node) => node.id === entityId)
  if (kind === 'mapping-add') return snapshot.mappings.find((mapping) => mapping.id === entityId)
  return snapshot.reviewItems.find((item) => item.id === entityId)
}

// ---------------------------------------------------------------------------
// 改动应用
// ---------------------------------------------------------------------------

function upsertInto<T extends { id: string }>(list: T[], next: T): T[] {
  const index = list.findIndex((item) => item.id === next.id)
  if (index === -1) return [...list, next]
  const copy = [...list]
  copy[index] = next
  return copy
}

function applyChange(snapshot: Snapshot, change: Change): Snapshot {
  switch (change.kind) {
    case 'node-upsert': {
      const existing = snapshot.nodes.find((node) => node.id === change.node!.id)
      // 只覆盖提交者关心的业务字段，保留最新的布局坐标。
      const merged: GraphNode = { ...existing, ...change.node!, x: existing?.x ?? change.node!.x, y: existing?.y ?? change.node!.y }
      return { ...snapshot, nodes: upsertInto(snapshot.nodes, merged) }
    }
    case 'mapping-add':
      return { ...snapshot, mappings: upsertInto(snapshot.mappings, change.mapping!) }
    case 'review-submit': {
      const { lockedRev: _omit, ...review } = change.review!
      void _omit
      return { ...snapshot, reviewItems: upsertInto(snapshot.reviewItems, review) }
    }
    case 'review-decision': {
      return {
        ...snapshot,
        reviewItems: snapshot.reviewItems.map((item) =>
          item.id === change.review!.id
            ? { ...item, status: change.decision!.status, comment: change.decision!.comment, lockedRev: undefined }
            : item,
        ),
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 变体内容序列化为可读值
// ---------------------------------------------------------------------------

export function variantValue(kind: ChangeKind, entity: GraphNode | Mapping | ReviewItem | undefined, change?: Change): string {
  // 优先采用改动自身携带的内容（冲突中“后提交版本”必须显示其新值，而非 base 旧值）。
  if (change?.kind === 'node-upsert' && change.node) entity = change.node
  if (change?.kind === 'mapping-add' && change.mapping) entity = change.mapping
  if (change && (change.kind === 'review-submit' || change.kind === 'review-decision') && change.review) entity = change.review
  if (!entity) {
    if (change?.kind === 'review-submit') return `${change.review!.evidence}（修订说明：${change.note ?? '—'}）`
    if (change?.kind === 'mapping-add') return `${change.mapping!.source} → ${change.mapping!.target} · ${change.mapping!.relation} · 权重 ${change.mapping!.weight}`
    return '（已删除）'
  }
  switch (kind) {
    case 'node-upsert': {
      const node = entity as GraphNode
      return `${node.label.split('\n')[0]}${node.owner ? ` · 负责人 ${node.owner}` : ''} · ${node.type}`
    }
    case 'mapping-add': {
      const mapping = entity as Mapping
      return `${mapping.source} → ${mapping.target} · ${mapping.relation} · 权重 ${mapping.weight}`
    }
    case 'review-submit': {
      const review = entity as ReviewItem
      const note = change?.note ? `；版本说明：${change.note}` : ''
      return `${review.evidence}（${review.status}${review.comment ? `；意见：${review.comment}` : ''}${note}）`
    }
    case 'review-decision': {
      if (change?.decision) return `${change.decision.status}：${change.decision.comment || '（无意见）'}`
      const review = entity as ReviewItem
      return `${review.status}：${review.comment || '（无意见）'}`
    }
  }
}

export function changeLabel(change: Change): string {
  switch (change.kind) {
    case 'node-upsert':
      return `修订节点 ${change.node!.id}`
    case 'mapping-add':
      return `新增映射 ${change.mapping!.id}（${change.mapping!.source} → ${change.mapping!.target}）`
    case 'review-submit':
      return `提交审阅 ${change.review!.id}`
    case 'review-decision':
      return `${change.decision!.status} ${change.review!.id}`
  }
}

// ---------------------------------------------------------------------------
// 三路合并提交
// ---------------------------------------------------------------------------

function toChange(input: CommitInput): Change {
  return { id: input.changeId, actor: input.actor, at: new Date().toISOString(), note: input.note, ...input.change }
}

function findCarriedConflict(conflicts: Conflict[], kind: ChangeKind, entityId: string): Conflict | undefined {
  return conflicts.find((conflict) => !conflict.resolved && conflict.kind === kind && conflict.entityId === entityId)
}

/** 已有未决冲突的同一项再次被改动时，更新对应来源，而不是堆叠新冲突。 */
function refreshVariant(conflict: Conflict, change: Change, rev: number, snapshot: Snapshot): Conflict {
  const variant: Variant = {
    rev,
    actor: change.actor,
    at: change.at,
    value: variantValue(change.kind, entityAt(snapshot, change.kind, changeEntityId(change)), change),
    changeId: change.id,
  }
  if (sameActor(change.actor, conflict.incoming.actor)) return { ...conflict, incoming: variant }
  if (sameActor(change.actor, conflict.head.actor)) return { ...conflict, head: variant }
  // 第三方再改同一项：视为当前工作版本一侧的更新，双方来源仍并列保留。
  return { ...conflict, head: variant }
}

export function commitRevision(doc: RevisionDoc, input: CommitInput): CommitOutcome {
  // 幂等：恢复重放时同一 changeId 不再生成记录。
  if (doc.revisions.some((revision) => revision.changeIds.includes(input.changeId))) {
    return { ok: true, doc, revision: doc.revisions[doc.revisions.length - 1], merged: false, conflictedChangeIds: [] }
  }
  if (!Number.isInteger(input.baseRev) || input.baseRev < 1 || input.baseRev > doc.headRev) {
    return { ok: false, reason: 'bad-base' }
  }

  const baseSnapshot = doc.revisions.find((revision) => revision.rev === input.baseRev)!.workingSnapshot
  let current = workingSnapshot(doc)
  const incoming = toChange(input)
  const merged = input.baseRev !== doc.headRev

  const concurrentChanges: Change[] = []
  if (merged) {
    for (const revision of doc.revisions.filter((item) => item.rev > input.baseRev && item.kind === 'commit')) {
      concurrentChanges.push(...revision.changeIds.map((id) => doc.changes[id]).filter((item): item is Change => Boolean(item)))
    }
  }

  let conflicts = doc.conflicts
  const conflictedChangeIds: string[] = []
  const rival = merged ? concurrentChanges.find((change) => overlaps(change, incoming)) : undefined
  const carried = findCarriedConflict(conflicts, incoming.kind, changeEntityId(incoming))

  if (carried) {
    conflicts = conflicts.map((conflict) => (conflict.id === carried.id ? refreshVariant(conflict, incoming, doc.headRev + 1, current) : conflict))
    conflictedChangeIds.push(incoming.id)
  } else if (rival) {
    conflicts = [
      ...conflicts,
      {
        id: `CFL-${incoming.id}`,
        kind: incoming.kind,
        entityId: changeEntityId(incoming),
        mergedAtRev: input.baseRev,
        head: {
          rev: doc.headRev,
          actor: rival.actor,
          at: rival.at,
          value: variantValue(rival.kind, entityAt(current, rival.kind, changeEntityId(rival)), rival),
          changeId: rival.id,
        },
        incoming: {
          rev: doc.headRev + 1,
          actor: incoming.actor,
          at: incoming.at,
          value: variantValue(incoming.kind, entityAt(baseSnapshot, incoming.kind, changeEntityId(incoming)), incoming),
          changeId: incoming.id,
        },
      },
    ]
    conflictedChangeIds.push(incoming.id)
  } else {
    current = applyChange(current, incoming)
  }

  const revision: Revision = {
    rev: doc.headRev + 1,
    kind: 'commit',
    baseRev: input.baseRev,
    actor: input.actor,
    at: incoming.at,
    note: input.note ?? changeLabel(incoming),
    changeIds: [incoming.id],
    workingSnapshot: current,
    conflicts,
  }
  const next: RevisionDoc = {
    ...doc,
    headRev: revision.rev,
    revisions: [...doc.revisions, revision],
    changes: { ...doc.changes, [incoming.id]: incoming },
    conflicts,
  }
  return { ok: true, doc: next, revision, merged, conflictedChangeIds }
}

// ---------------------------------------------------------------------------
// 冲突裁决：采用其中一份来源，产生一条新的提交修订
// ---------------------------------------------------------------------------

export function adoptConflict(
  doc: RevisionDoc,
  conflictId: string,
  variant: 'head' | 'incoming',
  actor: Actor,
  walOpId?: string,
): { ok: boolean; doc?: RevisionDoc; revision?: Revision; reason?: string; skipped?: boolean } {
  // WAL 幂等：同一恢复操作已完成时直接返回当前状态，不重复生成修订。
  if (walOpId && doc.revisions.some((revision) => revision.walOpId === walOpId)) {
    return { ok: true, doc, revision: doc.revisions[doc.revisions.length - 1], skipped: true }
  }
  const conflict = doc.conflicts.find((item) => item.id === conflictId && !item.resolved)
  if (!conflict) return { ok: false, reason: '冲突已裁决或不存在' }

  const current = workingSnapshot(doc)
  const pickedChange = doc.changes[conflict[variant].changeId]
  let nextSnapshot = current
  if (pickedChange) {
    nextSnapshot = applyChange(current, pickedChange)
  } else {
    // 兜底：从来源修订快照取回实体重新构造改动。
    const source = snapshotOf(doc, conflict[variant].rev)
    const entity = source ? entityAt(source, conflict.kind, conflict.entityId) : undefined
    const fallback: Change = {
      id: conflict[variant].changeId,
      kind: conflict.kind,
      actor: conflict[variant].actor,
      at: conflict[variant].at,
      ...(conflict.kind === 'node-upsert' ? { node: entity as GraphNode } : {}),
      ...(conflict.kind === 'mapping-add' ? { mapping: entity as Mapping } : {}),
      ...(conflict.kind === 'review-submit' ? { review: entity as ReviewItem } : {}),
      ...(conflict.kind === 'review-decision'
        ? { review: entity as ReviewItem, decision: { status: (entity as ReviewItem).status as '已附议' | '已退回', comment: (entity as ReviewItem).comment } }
        : {}),
    }
    if (entity) nextSnapshot = applyChange(current, fallback)
  }

  const resolutionChangeId = newChangeId()
  const now = new Date().toISOString()
  const label = variant === 'head' ? '当前版本' : '后提交版本'
  const conflicts = doc.conflicts.map((item) =>
    item.id === conflictId ? { ...item, resolved: { rev: doc.headRev + 1, actor, at: now, variant, note: `采用${label}` } } : item,
  )
  const revision: Revision = {
    rev: doc.headRev + 1,
    kind: 'commit',
    baseRev: doc.headRev,
    actor,
    at: now,
    note: `裁决冲突 ${conflict.entityId}：采用${label}（${conflict[variant].actor.name}/${conflict[variant].actor.role}）`,
    changeIds: [resolutionChangeId],
    workingSnapshot: nextSnapshot,
    conflicts,
    ...(walOpId ? { walOpId } : {}),
  }
  return {
    ok: true,
    doc: { ...doc, headRev: revision.rev, revisions: [...doc.revisions, revision], conflicts },
    revision,
  }
}

// ---------------------------------------------------------------------------
// 发布锁版：只纳入已采用（已附议）的修改，退回项仍留在队列
// ---------------------------------------------------------------------------

export function publishRelease(
  doc: RevisionDoc,
  note: string,
  actor: Actor,
  walOpId?: string,
): { doc: RevisionDoc; revision: Revision; skipped?: boolean } {
  // WAL 幂等：同一发布操作已完成（主写其实成功、仅确认失败）则直接返回，不重复锁版。
  if (walOpId && doc.revisions.some((revision) => revision.walOpId === walOpId)) {
    return { doc, revision: doc.revisions[doc.revisions.length - 1], skipped: true }
  }
  const current = workingSnapshot(doc)
  const adoptedReviewIds = new Set(
    current.reviewItems.filter((item) => item.status === '已附议' && item.lockedRev == null).map((item) => item.id),
  )
  const lockRev = doc.headRev + 1
  const publishedSnapshot: Snapshot = {
    nodes: current.nodes,
    mappings: current.mappings,
    // 已退回与待审阅项不进入锁版；已附议项标记纳入版本。
    reviewItems: current.reviewItems
      .filter((item) => item.status === '已附议')
      .map((item) => ({ ...item, lockedRev: adoptedReviewIds.has(item.id) ? lockRev : item.lockedRev ?? lockRev })),
  }
  const working: Snapshot = {
    ...current,
    reviewItems: current.reviewItems.map((item) => (adoptedReviewIds.has(item.id) ? { ...item, lockedRev: lockRev } : item)),
  }
  const now = new Date().toISOString()
  const revision: Revision = {
    rev: lockRev,
    kind: 'release',
    baseRev: doc.headRev,
    actor,
    at: now,
    note,
    changeIds: [],
    workingSnapshot: working,
    publishedSnapshot,
    conflicts: doc.conflicts,
    ...(walOpId ? { walOpId } : {}),
  }
  return {
    doc: { ...doc, headRev: lockRev, revisions: [...doc.revisions, revision], lastReleaseRev: lockRev },
    revision,
  }
}

// ---------------------------------------------------------------------------
// 兼容升级：旧数据缺少修订号时整体作为第 1 版
// ---------------------------------------------------------------------------

function cloneSnapshot(snapshot: Snapshot): Snapshot {
  return {
    nodes: snapshot.nodes.map((node) => ({ ...node })),
    mappings: snapshot.mappings.map((mapping) => ({ ...mapping })),
    reviewItems: snapshot.reviewItems.map((item) => ({ ...item })),
  }
}

export type LegacyState = Partial<{
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  revision: string
  locked: boolean
  draft: string
}>

export function migrateLegacy(legacy: LegacyState | null | undefined, source: 'seed' | 'storage'): RevisionDoc {
  const seed: Snapshot = { nodes: seedState.nodes, mappings: seedState.mappings, reviewItems: seedState.reviewItems }
  const snapshot: Snapshot = cloneSnapshot({
    nodes: legacy?.nodes ?? seed.nodes,
    mappings: legacy?.mappings ?? seed.mappings,
    reviewItems: legacy?.reviewItems ?? seed.reviewItems,
  })
  const layout: RevisionDoc['layout'] = {}
  for (const node of snapshot.nodes) layout[node.id] = { x: node.x, y: node.y }
  const first: Revision = {
    rev: 1,
    kind: 'init',
    baseRev: 0,
    actor: null,
    at: new Date().toISOString(),
    note:
      source === 'storage'
        ? `兼容升级：旧数据（原标记 ${legacy?.revision ?? '无版本号'}）缺少修订号，整体作为第 1 版`
        : `初始化：导入种子数据作为第 1 版（原标记 ${seedState.revision}）`,
    changeIds: [],
    workingSnapshot: snapshot,
    ...(legacy?.locked ? { publishedSnapshot: cloneSnapshot(snapshot) } : {}),
    conflicts: [],
  }
  return {
    format: 2,
    headRev: 1,
    revisions: [first],
    changes: {},
    conflicts: [],
    pendingWrites: [],
    lastReleaseRev: legacy?.locked ? 1 : null,
    draft: legacy?.draft ?? '',
    layout,
  }
}

// ---------------------------------------------------------------------------
// 恢复：按记录失败时的修订号重放待写操作；changeId 幂等保证不重复生成记录
// ---------------------------------------------------------------------------

export function replayPending(doc: RevisionDoc, pending: PendingWrite): { doc: RevisionDoc; revision?: Revision; skipped?: boolean } {
  const { payload } = pending
  if (payload.op === 'commit') {
    // 重放前的幂等检查：该改动已在历史中（如主写入其实成功、仅确认失败），直接跳过。
    if (doc.revisions.some((revision) => revision.changeIds.includes(payload.input.changeId))) {
      return { doc, skipped: true }
    }
    const result = commitRevision(doc, payload.input)
    if (result.ok) return { doc: result.doc, revision: result.revision }
    return { doc }
  }
  if (payload.op === 'adopt') {
    const result = adoptConflict(doc, payload.conflictId, payload.variant, payload.actor, payload.walOpId)
    if (result.ok && result.doc) return { doc: result.doc, revision: result.revision, skipped: result.skipped }
    return { doc }
  }
  const released = publishRelease(doc, payload.note, payload.actor, payload.walOpId)
  return { doc: released.doc, revision: released.revision, skipped: released.skipped }
}

/** 实体摘要，供界面展示冲突项。 */
export function describeEntity(doc: RevisionDoc, kind: ChangeKind, entityId: string): string {
  const snapshot = workingSnapshot(doc)
  const entity = entityAt(snapshot, kind, entityId)
  if (entity) {
    if (kind === 'node-upsert') return `${(entity as GraphNode).label.split('\n')[0]}（${entityId}）`
    if (kind === 'mapping-add') {
      const mapping = entity as Mapping
      const from = snapshot.nodes.find((node) => node.id === mapping.source)?.label.split('\n')[0] ?? mapping.source
      const to = snapshot.nodes.find((node) => node.id === mapping.target)?.label.split('\n')[0] ?? mapping.target
      return `映射 ${entityId}：${from} → ${to}`
    }
    const review = entity as ReviewItem
    return `审阅项 ${entityId}（课程 ${review.courseId} / 要求 ${review.requirementId}）`
  }
  if (kind === 'node-upsert') return `节点 ${entityId}`
  if (kind === 'mapping-add') return `映射 ${entityId}`
  return `审阅项 ${entityId}`
}
