import { writable } from 'svelte/store'
import { browser } from '$app/environment'
import type { GraphNode, Mapping, ReviewItem } from './seed'
import {
  deriveState,
  migrateLegacy,
  newId,
  now,
  type ConflictInfo,
  type CurriculumState,
  type Op,
  type Revision,
} from './revision'

const DRAFT_KEY = 'curriculum-revision-draft-v2'
const LEGACY_KEY = 'curriculum-map-draft-v1'

type LocalDraft = {
  base: number
  pendingOps: Op[]
  idempotencyKey: string | null
  submitAttempted: boolean
  origin: string
}

type StoreState = CurriculumState & {
  base: number
  head: number
  pendingOps: Op[]
  conflicts: ConflictInfo[]
  idempotencyKey: string | null
  lastSubmitAt: string | null
  origin: string
  publishedUpTo: number
  locked: boolean
  viewingRevision: number | null
}

function defaultDraft(): LocalDraft {
  return { base: 0, pendingOps: [], idempotencyKey: null, submitAttempted: false, origin: '课程负责人' }
}

/** 从 localStorage 读取草稿；旧数据缺少修订号时兼容升级为首版 R1。 */
function loadDraft(): LocalDraft {
  if (!browser) return defaultDraft()
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (raw) return { ...defaultDraft(), ...(JSON.parse(raw) as Partial<LocalDraft>) }
    // 兼容旧版草稿
    const legacy = localStorage.getItem(LEGACY_KEY)
    if (legacy) {
      migrateLegacy(JSON.parse(legacy))
      return { ...defaultDraft(), base: 1 }
    }
  } catch {
    // ignore
  }
  return defaultDraft()
}

function persistDraft(state: StoreState) {
  if (!browser) return
  const draft: LocalDraft = {
    base: state.base,
    pendingOps: state.pendingOps,
    idempotencyKey: state.idempotencyKey,
    submitAttempted: state.lastSubmitAt !== null,
    origin: state.origin,
  }
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
}

function createCurriculumStore() {
  const draft = loadDraft()
  const { subscribe, update } = writable<StoreState>({
    ...deriveState([]),
    base: draft.base,
    head: 0,
    pendingOps: draft.pendingOps,
    conflicts: [],
    idempotencyKey: draft.idempotencyKey,
    lastSubmitAt: null,
    origin: draft.origin,
    publishedUpTo: 0,
    locked: false,
    viewingRevision: null,
  })

  subscribe(persistDraft)

  /** 在当前状态上应用一批 op（乐观更新）。 */
  function applyOpsLocally(state: StoreState, ops: Op[]): StoreState {
    const next = { ...state }
    for (const op of ops) {
      switch (op.type) {
        case 'mapping:add': {
          const m = op.payload as unknown as Mapping
          if (!next.mappings.some((x) => x.id === m.id)) next.mappings.push({ ...m })
          break
        }
        case 'mapping:update': {
          const idx = next.mappings.findIndex((x) => x.id === op.targetId)
          if (idx >= 0) next.mappings[idx] = { ...next.mappings[idx], ...(op.payload as Partial<Mapping>) }
          break
        }
        case 'mapping:delete': {
          next.mappings = next.mappings.filter((x) => x.id !== op.targetId)
          break
        }
        case 'review:add': {
          const r = op.payload as unknown as ReviewItem
          if (!next.reviewItems.some((x) => x.id === r.id)) next.reviewItems.push({ ...r })
          break
        }
        case 'review:decision':
        case 'review:comment': {
          const idx = next.reviewItems.findIndex((x) => x.id === op.targetId)
          if (idx >= 0) next.reviewItems[idx] = { ...next.reviewItems[idx], ...(op.payload as Partial<ReviewItem>) }
          break
        }
        case 'draft:note': {
          next.draft = op.payload.note as string
          next.draftVersions.push({ text: next.draft, origin: op.origin, at: op.at })
          break
        }
        case 'node:move': {
          const idx = next.nodes.findIndex((x) => x.id === op.targetId)
          if (idx >= 0) next.nodes[idx] = { ...next.nodes[idx], ...(op.payload as Partial<GraphNode>) }
          break
        }
      }
    }
    return next
  }

  function addOp(op: Op) {
    update((state) => {
      const pendingOps = [...state.pendingOps, op]
      return { ...applyOpsLocally(state, [op]), pendingOps }
    })
  }

  return {
    subscribe,

    setOrigin(origin: string) {
      update((state) => ({ ...state, origin }))
    },

    // ---- 本地修改（生成 op，乐观更新） ----

    moveNode(id: string, x: number, y: number) {
      addOp({ id: newId('op'), type: 'node:move', targetId: id, payload: { x, y }, origin: '课程负责人', at: now() })
    },

    addMapping(source: string, target: string, relation: Mapping['relation'], weight: number) {
      const id = `M-${Date.now()}`
      addOp({ id: newId('op'), type: 'mapping:add', targetId: id, payload: { id, source, target, relation, weight }, origin: '课程负责人', at: now() })
    },

    updateMapping(id: string, patch: Partial<Mapping>) {
      addOp({ id: newId('op'), type: 'mapping:update', targetId: id, payload: patch, origin: '课程负责人', at: now() })
    },

    removeMapping(id: string) {
      addOp({ id: newId('op'), type: 'mapping:delete', targetId: id, payload: {}, origin: '课程负责人', at: now() })
    },

    updateReview(id: string, status: ReviewItem['status'], comment: string) {
      addOp({ id: newId('op'), type: 'review:decision', targetId: id, payload: { status, comment }, origin: '院系审阅人', at: now() })
    },

    addReview(item: Omit<ReviewItem, 'id' | 'status' | 'comment' | 'origin'>) {
      const id = `REV-${Date.now().toString().slice(-4)}`
      const review: ReviewItem = { ...item, id, status: '待审阅', comment: '' }
      addOp({ id: newId('op'), type: 'review:add', targetId: id, payload: { ...review }, origin: item.submitter, at: now() })
      return id
    },

    saveDraftNote(note: string) {
      addOp({ id: newId('op'), type: 'draft:note', targetId: 'draft', payload: { note }, origin: '课程负责人', at: now() })
    },

    // ---- 修订流程 ----

    /** 提交修订：带上所见版本 base + 本地 ops，服务端三路合并。 */
    async submitRevision(submitter: string, note: string): Promise<{ ok: boolean; head: number; conflicts: ConflictInfo[]; duplicate: boolean }> {
      let current: StoreState | undefined
      const unsub = subscribe((s) => (current = s))
      unsub()
      if (!current) return { ok: false, head: 0, conflicts: [], duplicate: false }

      const idempotencyKey = current.idempotencyKey ?? newId('idem')
      update((s) => ({ ...s, idempotencyKey, lastSubmitAt: now() }))

      try {
        const response = await fetch('/api/curriculum/revisions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ base: current.base, ops: current.pendingOps, submitter, note, idempotencyKey }),
        })
        const result = await response.json()
        if (!response.ok || !result.ok) {
          return { ok: false, head: current.head, conflicts: [], duplicate: false }
        }
        // 提交成功（或幂等命中）：先清除已提交的 pendingOps，再采用服务端状态
        update((s) => ({ ...s, pendingOps: [], idempotencyKey: null, lastSubmitAt: null, conflicts: result.conflicts ?? [] }))
        await this.recover(result.head)
        return { ok: true, head: result.head, conflicts: result.conflicts ?? [], duplicate: result.duplicate ?? false }
      } catch {
        // 写入失败：保留 pendingOps + idempotencyKey，重开后按修订号恢复
        return { ok: false, head: current.head, conflicts: [], duplicate: false }
      }
    },

    /** 从服务端恢复最新状态；若有未完成的提交则自动重试（幂等，不重复生成记录）。 */
    async recover(targetHead?: number): Promise<void> {
      try {
        const response = await fetch('/api/curriculum/state')
        const server = await response.json()
        update((s) => {
          const merged = applyOpsLocally({ ...server, pendingOps: s.pendingOps }, s.pendingOps)
          return {
            ...s,
            ...merged,
            base: server.head,
            head: server.head,
            publishedUpTo: server.publishedUpTo,
            locked: server.publishedUpTo > 0,
            viewingRevision: null,
          }
        })
      } catch {
        // 离线时保留本地状态
      }
    },

    /** 发布锁版：只纳入已采用的修改。 */
    async publish(): Promise<{ ok: boolean }> {
      let current: StoreState | undefined
      const unsub = subscribe((s) => (current = s))
      unsub()
      if (!current) return { ok: false }
      const response = await fetch('/api/curriculum/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: current.head }),
      })
      const result = await response.json()
      if (result.ok) {
        update((s) => ({ ...s, publishedUpTo: result.publishedUpTo, locked: true }))
      }
      return { ok: result.ok }
    },

    /** 按修订号查看旧版状态（旧版可查）。 */
    async viewRevision(number: number): Promise<{ ok: boolean; state?: CurriculumState; revision?: Revision }> {
      try {
        const response = await fetch(`/api/curriculum/revisions/${number}`)
        const result = await response.json()
        if (!result.ok) return { ok: false }
        update((s) => ({ ...s, viewingRevision: number }))
        return { ok: true, state: result, revision: result.revision }
      } catch {
        return { ok: false }
      }
    },

    clearViewing() {
      update((s) => ({ ...s, viewingRevision: null }))
    },
  }
}

export const curriculumStore = createCurriculumStore()

// 启动时恢复：若有未完成的提交，按修订号恢复（幂等，不重复生成记录）
if (browser) {
  const draft = loadDraft()
  curriculumStore.recover().then(() => {
    if (draft.submitAttempted && draft.pendingOps.length > 0) {
      curriculumStore.submitRevision('系统恢复', '写入失败后按修订号恢复。').catch(() => {})
    }
  })
}

export function validateCurriculum(state: CurriculumState) {
  const issues: Array<{ id: string; severity: '错误' | '警告'; title: string; detail: string }> = []
  const outgoing = new Map<string, Mapping[]>()
  state.mappings.forEach((mapping) => outgoing.set(mapping.source, [...(outgoing.get(mapping.source) ?? []), mapping]))
  state.nodes.filter((node) => node.type === '毕业要求').forEach((node) => {
    if (!(outgoing.get(node.id) ?? []).some((mapping) => state.nodes.find((item) => item.id === mapping.target)?.type === '课程')) {
      issues.push({ id: `coverage-${node.id}`, severity: '错误', title: `${node.label.split('\n')[0]} 存在覆盖缺口`, detail: '未关联任何课程支撑证据。' })
    }
  })
  const seen = new Set<string>()
  state.mappings.forEach((mapping) => {
    const key = `${mapping.source}-${mapping.target}-${mapping.relation}`
    if (seen.has(key)) issues.push({ id: `dup-${mapping.id}`, severity: '警告', title: `${mapping.id} 为重复映射`, detail: '相同来源、目标和关系重复录入，可合并。' })
    seen.add(key)
  })
  return issues
}
