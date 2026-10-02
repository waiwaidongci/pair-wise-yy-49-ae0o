import type { GraphNode, Mapping, ReviewItem } from './seed'
import { nodes as seedNodes, mappings as seedMappings, reviewItems as seedReviewItems } from './seed'

// ============ 修订模型类型 ============

export type OpType =
  | 'mapping:add'
  | 'mapping:update'
  | 'mapping:delete'
  | 'review:add'
  | 'review:decision'
  | 'review:comment'
  | 'draft:note'
  | 'node:move'

export type ReviewStatus = '待审阅' | '已附议' | '已退回'

/** 单次修改操作（op）。每次提交由若干 op 组成。 */
export type Op = {
  id: string
  type: OpType
  targetId: string
  payload: Record<string, unknown>
  /** 本次修改的来源（课程负责人 / 院系审阅人） */
  origin: string
  at: string
}

/** 一条修订记录。 */
export type Revision = {
  number: number
  label: string
  parent: number
  /** 提交方当时所见的修订号（乐观并发基准） */
  base: number
  at: string
  submitter: string
  note: string
  ops: Op[]
  published: boolean
}

export type DraftVersion = { text: string; origin: string; at: string }

export type CurriculumState = {
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  draft: string
  draftVersions: DraftVersion[]
}

export type ConflictInfo = {
  targetId: string
  targetLabel: string
  incomingOrigin: string
  existingOrigin: string
  kind: 'mapping' | 'review' | 'draft'
}

// ============ 工具 ============

export function slugify(s: string): string {
  return s.replace(/[^\w一-龥]+/g, '_').slice(0, 24)
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function now(): string {
  return new Date().toISOString()
}

export function emptyState(): CurriculumState {
  return {
    nodes: structuredClone(seedNodes),
    mappings: structuredClone(seedMappings),
    reviewItems: structuredClone(seedReviewItems),
    draft: '初始版本：课程图谱与审阅队列已建立。',
    draftVersions: [],
  }
}

// ============ 旧数据兼容升级 ============

/**
 * 旧数据缺少修订号时，兼容升级为首版 R1。
 * 把已有数据当作 R1 的内容，之后的新修改按新版本保存。
 */
export function migrateLegacy(raw: {
  nodes?: GraphNode[]
  mappings?: Mapping[]
  reviewItems?: ReviewItem[]
  draft?: string
  revision?: string
}): Revision[] {
  const state = emptyState()
  if (Array.isArray(raw.nodes) && raw.nodes.length) state.nodes = raw.nodes
  if (Array.isArray(raw.mappings) && raw.mappings.length) state.mappings = raw.mappings
  if (Array.isArray(raw.reviewItems) && raw.reviewItems.length) state.reviewItems = raw.reviewItems
  if (typeof raw.draft === 'string' && raw.draft.trim()) state.draft = raw.draft

  const ops: Op[] = []
  state.mappings.forEach((m) =>
    ops.push({ id: newId('op'), type: 'mapping:add', targetId: m.id, payload: { ...m }, origin: '兼容迁移', at: new Date(0).toISOString() }),
  )
  state.reviewItems.forEach((r) =>
    ops.push({ id: newId('op'), type: 'review:add', targetId: r.id, payload: { ...r }, origin: '兼容迁移', at: new Date(0).toISOString() }),
  )
  ops.push({
    id: newId('op'),
    type: 'draft:note',
    targetId: 'draft',
    payload: { note: state.draft },
    origin: '兼容迁移',
    at: new Date(0).toISOString(),
  })

  const r1: Revision = {
    number: 1,
    label: 'R1',
    parent: 0,
    base: 0,
    at: new Date(0).toISOString(),
    submitter: '系统迁移',
    note: raw.revision ? `旧数据（${raw.revision}）缺少修订号，已兼容升级为首版 R1。` : '旧数据缺少修订号，已兼容升级为首版 R1。',
    ops,
    published: false,
  }
  return [r1]
}

// ============ 状态派生 ============

function applyOp(state: CurriculumState, op: Op) {
  switch (op.type) {
    case 'mapping:add': {
      const m = op.payload as unknown as Mapping
      if (!state.mappings.some((x) => x.id === m.id)) state.mappings.push({ ...m })
      break
    }
    case 'mapping:update': {
      const idx = state.mappings.findIndex((x) => x.id === op.targetId)
      if (idx >= 0) state.mappings[idx] = { ...state.mappings[idx], ...(op.payload as Partial<Mapping>), origin: op.origin }
      break
    }
    case 'mapping:delete': {
      state.mappings = state.mappings.filter((x) => x.id !== op.targetId)
      break
    }
    case 'review:add': {
      const r = op.payload as unknown as ReviewItem
      if (!state.reviewItems.some((x) => x.id === r.id)) state.reviewItems.push({ ...r })
      break
    }
    case 'review:decision':
    case 'review:comment': {
      const idx = state.reviewItems.findIndex((x) => x.id === op.targetId)
      if (idx >= 0) state.reviewItems[idx] = { ...state.reviewItems[idx], ...(op.payload as Partial<ReviewItem>), origin: op.origin }
      break
    }
    case 'draft:note': {
      const note = op.payload.note as string
      state.draft = note
      state.draftVersions.push({ text: note, origin: op.origin, at: op.at })
      break
    }
    case 'node:move': {
      const idx = state.nodes.findIndex((x) => x.id === op.targetId)
      if (idx >= 0) state.nodes[idx] = { ...state.nodes[idx], ...(op.payload as Partial<GraphNode>) }
      break
    }
  }
}

/** 按修订号派生状态；upTo 可指定只看到某一修订号（旧版可查）。 */
export function deriveState(revisions: Revision[], upTo?: number): CurriculumState {
  const state = emptyState()
  const sorted = [...revisions].sort((a, b) => a.number - b.number)
  for (const rev of sorted) {
    if (upTo !== undefined && rev.number > upTo) break
    for (const op of rev.ops) applyOp(state, op)
  }
  return state
}

/**
 * 发布锁版状态：只纳入已采用（已附议）的修改。
 * 退回项仍留在队列（草稿状态里保留），不进入锁版快照。
 */
export function derivePublishedState(revisions: Revision[], publishedUpTo: number): CurriculumState {
  const state = deriveState(revisions, publishedUpTo)
  state.reviewItems = state.reviewItems.filter((r) => r.status === '已附议')
  return state
}

// ============ 三路合并 ============

/** 取某目标在 base 之后被修改的最新 op。 */
function latestOpByTarget(revisions: Revision[], base: number): Map<string, Op> {
  const map = new Map<string, Op>()
  for (const rev of revisions) {
    if (rev.number <= base) continue
    for (const op of rev.ops) {
      const prev = map.get(op.targetId)
      if (!prev || op.at >= prev.at) map.set(op.targetId, op)
    }
  }
  return map
}

function resolveConflict(
  baseState: CurriculumState,
  op: Op,
  other: Op,
  submitter: string,
): { op: Op | null; conflict: ConflictInfo } {
  const at = now()
  switch (op.type) {
    case 'mapping:update': {
      const baseItem = baseState.mappings.find((m) => m.id === op.targetId)
      const conflictId = `${op.targetId}__cf_${slugify(submitter)}`
      const duplicate: Mapping = {
        ...(baseItem ?? { id: op.targetId, source: '', target: '', relation: '支撑', weight: 0 }),
        ...(op.payload as Partial<Mapping>),
        id: conflictId,
        origin: submitter,
        conflictOf: op.targetId,
      }
      return {
        op: { ...op, id: newId('op'), type: 'mapping:add', targetId: conflictId, payload: duplicate, origin: submitter, at },
        conflict: {
          targetId: op.targetId,
          targetLabel: `${duplicate.source} → ${duplicate.target}`,
          incomingOrigin: submitter,
          existingOrigin: other.origin,
          kind: 'mapping',
        },
      }
    }
    case 'mapping:add': {
      const m = op.payload as unknown as Mapping
      const conflictId = `${m.id}__cf_${slugify(submitter)}`
      const duplicate: Mapping = { ...m, id: conflictId, origin: submitter, conflictOf: m.id }
      return {
        op: { ...op, id: newId('op'), targetId: conflictId, payload: duplicate, origin: submitter, at },
        conflict: {
          targetId: op.targetId,
          targetLabel: `${duplicate.source} → ${duplicate.target}`,
          incomingOrigin: submitter,
          existingOrigin: other.origin,
          kind: 'mapping',
        },
      }
    }
    case 'review:decision':
    case 'review:comment': {
      const baseItem = baseState.reviewItems.find((r) => r.id === op.targetId)
      const conflictId = `${op.targetId}__cf_${slugify(submitter)}`
      const duplicate: ReviewItem = {
        ...(baseItem ?? { id: op.targetId, courseId: '', requirementId: '', evidence: '', submitter: '', status: '待审阅', comment: '' }),
        ...(op.payload as Partial<ReviewItem>),
        id: conflictId,
        origin: submitter,
        conflictOf: op.targetId,
      }
      return {
        op: { ...op, id: newId('op'), type: 'review:add', targetId: conflictId, payload: duplicate, origin: submitter, at },
        conflict: {
          targetId: op.targetId,
          targetLabel: duplicate.id,
          incomingOrigin: submitter,
          existingOrigin: other.origin,
          kind: 'review',
        },
      }
    }
    case 'review:add': {
      const r = op.payload as unknown as ReviewItem
      const conflictId = `${r.id}__cf_${slugify(submitter)}`
      const duplicate: ReviewItem = { ...r, id: conflictId, origin: submitter, conflictOf: r.id }
      return {
        op: { ...op, id: newId('op'), targetId: conflictId, payload: duplicate, origin: submitter, at },
        conflict: {
          targetId: op.targetId,
          targetLabel: duplicate.id,
          incomingOrigin: submitter,
          existingOrigin: other.origin,
          kind: 'review',
        },
      }
    }
    case 'draft:note': {
      // 版本说明双方都改：保留两份，标明来源
      const incomingNote = op.payload.note as string
      const otherNote = other.payload.note as string
      const combined = `[${other.origin}] ${otherNote}\n[${submitter}] ${incomingNote}`
      return {
        op: { ...op, origin: submitter, at, payload: { note: combined } },
        conflict: {
          targetId: 'draft',
          targetLabel: '版本说明',
          incomingOrigin: submitter,
          existingOrigin: other.origin,
          kind: 'draft',
        },
      }
    }
    case 'mapping:delete': {
      // 一方删除、另一方改过：保留该项，不丢失工作
      return {
        op: null,
        conflict: {
          targetId: op.targetId,
          targetLabel: op.targetId,
          incomingOrigin: submitter,
          existingOrigin: other.origin,
          kind: 'mapping',
        },
      }
    }
    default:
      return {
        op,
        conflict: {
          targetId: op.targetId,
          targetLabel: op.targetId,
          incomingOrigin: submitter,
          existingOrigin: other.origin,
          kind: 'mapping',
        },
      }
  }
}

/**
 * 三路合并：以 base 为基准，把 incoming ops 合入当前修订链。
 * - 未冲突内容直接合用；
 * - 同一项双方都改过：保留两份并标明来源。
 */
export function mergeOps(
  revisions: Revision[],
  base: number,
  incoming: Op[],
  submitter: string,
): { ops: Op[]; conflicts: ConflictInfo[] } {
  const baseState = deriveState(revisions, base)
  const otherByTarget = latestOpByTarget(revisions, base)

  const merged: Op[] = []
  const conflicts: ConflictInfo[] = []

  for (const op of incoming) {
    const other = otherByTarget.get(op.targetId)
    if (!other) {
      merged.push(op)
      continue
    }
    const resolved = resolveConflict(baseState, op, other, submitter)
    if (resolved.op) merged.push(resolved.op)
    conflicts.push(resolved.conflict)
  }

  return { ops: merged, conflicts }
}

// ============ 发布与采用 ============

/** 判断某修订是否已发布（锁版）。 */
export function isPublished(revision: Revision, publishedUpTo: number): boolean {
  return revision.number <= publishedUpTo
}

/** 从状态中筛出可发布的已采用修改（用于锁版快照）。 */
export function adoptedReviewItems(state: CurriculumState): ReviewItem[] {
  return state.reviewItems.filter((r) => r.status === '已附议')
}
