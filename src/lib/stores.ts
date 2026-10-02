import { writable } from 'svelte/store'
import { browser } from '$app/environment'
import type { GraphNode, Mapping, ReviewItem } from './seed'
import {
  adoptConflict,
  commitRevision,
  migrateLegacy,
  newChangeId,
  publishRelease,
  replayPending,
  workingSnapshot,
  type Actor,
  type Change,
  type CommitInput,
  type Conflict,
  type PendingWrite,
  type Revision,
  type RevisionDoc,
  type Role,
  type Snapshot,
} from './revision'

const DOC_KEY = 'curriculum-map-revisions-v2'
const LEGACY_KEY = 'curriculum-map-draft-v1'
const ACTOR_KEY = 'curriculum-actor-v2'

export type OpNotice = { id: string; tone: 'success' | 'info' | 'error'; text: string }

export type CurriculumView = {
  doc: RevisionDoc
  /** 正在查看的历史/锁版修订号；null 表示当前工作版本。 */
  viewRev: number | null
  viewing: Revision | null
  isLockedView: boolean
  readonly: boolean
  rev: number
  headRev: number
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  conflicts: Conflict[]
  pendingWrites: PendingWrite[]
  revisions: Revision[]
  lastReleaseRev: number | null
  draft: string
  actor: Actor
  failWrites: boolean
  notices: OpNotice[]
}

type Internal = {
  doc: RevisionDoc
  viewRev: number | null
  actor: Actor
  failWrites: boolean
  notices: OpNotice[]
}

// ---------------------------------------------------------------------------
// 加载与兼容升级
// ---------------------------------------------------------------------------

function normalizeDoc(parsed: unknown): RevisionDoc | null {
  if (!parsed || typeof parsed !== 'object') return null
  const candidate = parsed as Partial<RevisionDoc>
  if (candidate.format !== 2 || !Array.isArray(candidate.revisions) || candidate.revisions.length === 0) return null
  return {
    format: 2,
    headRev: candidate.headRev ?? candidate.revisions[candidate.revisions.length - 1].rev,
    revisions: candidate.revisions,
    changes: candidate.changes ?? {},
    conflicts: candidate.conflicts ?? [],
    pendingWrites: candidate.pendingWrites ?? [],
    lastReleaseRev: candidate.lastReleaseRev ?? null,
    draft: candidate.draft ?? '',
    layout: candidate.layout ?? {},
  }
}

function loadDoc(): RevisionDoc {
  if (!browser) return migrateLegacy(null, 'seed')
  try {
    const raw = localStorage.getItem(DOC_KEY)
    if (raw) {
      const doc = normalizeDoc(JSON.parse(raw))
      if (doc) return doc
    }
    const legacyRaw = localStorage.getItem(LEGACY_KEY)
    if (legacyRaw) return migrateLegacy(JSON.parse(legacyRaw) as Parameters<typeof migrateLegacy>[0], 'storage')
  } catch {
    // 存储损坏时退回种子数据，避免页面白屏。
  }
  return migrateLegacy(null, 'seed')
}

function loadActor(): Actor {
  const fallback: Actor = { name: '顾明', role: '课程负责人' }
  if (!browser) return fallback
  try {
    const raw = localStorage.getItem(ACTOR_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Actor
      if (parsed && typeof parsed.name === 'string' && (parsed.role === '课程负责人' || parsed.role === '院系审阅人')) return parsed
    }
  } catch {
    // ignore
  }
  return fallback
}

function persist(doc: RevisionDoc): void {
  if (!browser) return
  localStorage.setItem(DOC_KEY, JSON.stringify(doc))
}

// ---------------------------------------------------------------------------
// 视图派生
// ---------------------------------------------------------------------------

function buildView(internal: Internal): CurriculumView {
  const { doc } = internal
  const viewing = internal.viewRev ? doc.revisions.find((revision) => revision.rev === internal.viewRev) ?? null : null
  const snapshot: Snapshot = viewing ? viewing.publishedSnapshot ?? viewing.workingSnapshot : workingSnapshot(doc)
  const nodes =
    viewing || !browser
      ? snapshot.nodes.map((node) => ({ ...node }))
      : // 当前工作版本叠加未纳入修订的布局坐标；历史版本保持冻结坐标。
        snapshot.nodes.map((node) => ({ ...node, ...(doc.layout[node.id] ?? {}) }))
  return {
    doc,
    viewRev: internal.viewRev,
    viewing,
    isLockedView: Boolean(viewing?.publishedSnapshot),
    readonly: viewing !== null,
    rev: viewing?.rev ?? doc.headRev,
    headRev: doc.headRev,
    nodes,
    mappings: snapshot.mappings.map((mapping) => ({ ...mapping })),
    reviewItems: snapshot.reviewItems.map((item) => ({ ...item })),
    conflicts: doc.conflicts,
    pendingWrites: doc.pendingWrites,
    revisions: doc.revisions,
    lastReleaseRev: doc.lastReleaseRev,
    draft: doc.draft,
    actor: internal.actor,
    failWrites: internal.failWrites,
    notices: internal.notices,
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function createCurriculumStore() {
  let doc = loadDoc()
  // 重新打开：先按修订号重放上次失败的待写操作，changeId 幂等保证不会重复生成记录。
  if (browser && doc.pendingWrites.length > 0) {
    let recovered = 0
    for (const pending of [...doc.pendingWrites]) {
      const result = replayPending(doc, pending)
      doc = result.doc
      if (result.revision && !result.skipped) recovered += 1
      doc = { ...doc, pendingWrites: doc.pendingWrites.filter((item) => item.opId !== pending.opId) }
    }
    try {
      persist(doc)
      if (recovered > 0) setTimeout(() => pushNotice('success', `已按修订号自动恢复 ${recovered} 条失败写入，未重复生成记录。`), 0)
    } catch {
      // 存储仍不可用时保留待恢复队列，等待手动恢复。
    }
  }

  const internal: Internal = { doc, viewRev: null, actor: loadActor(), failWrites: false, notices: [] }
  const { subscribe, set } = writable<CurriculumView>(buildView(internal))

  function sync() {
    set(buildView(internal))
  }

  function pushNotice(tone: OpNotice['tone'], text: string): string {
    const id = newChangeId()
    internal.notices = [...internal.notices, { id, tone, text }]
    sync()
    if (tone === 'success') setTimeout(() => dismissNotice(id), 6000)
    return id
  }

  function dismissNotice(id: string) {
    internal.notices = internal.notices.filter((notice) => notice.id !== id)
    sync()
  }

  function guardEditable(): boolean {
    if (internal.viewRev !== null) {
      pushNotice('error', `正在查看 R${internal.viewRev} 历史版本，已只读；请先回到当前工作版本 R${internal.doc.headRev}。`)
      return false
    }
    return true
  }

  type Applied = { doc: RevisionDoc; revision?: Revision; merged?: boolean; conflictedChangeIds?: string[] }

  /**
   * 统一写入口：先持久化待写日志（WAL，记录失败时修订号），再执行主写入。
   * 主写入失败时改动留在待恢复队列，重新打开或手动恢复时按修订号重放。
   */
  function runOp(
    payload: PendingWrite['payload'],
    apply: (doc: RevisionDoc) => Applied,
    describe: (revision: Revision, merged: boolean, conflicted: boolean) => string,
  ): Applied | null {
    if (!guardEditable()) return null
    const entry: PendingWrite = { opId: newChangeId(), originRev: internal.doc.headRev, at: new Date().toISOString(), payload }
    const withWal: RevisionDoc = { ...internal.doc, pendingWrites: [...internal.doc.pendingWrites, entry] }
    try {
      persist(withWal)
    } catch {
      internal.doc = withWal
      sync()
      pushNotice('error', '待写日志也无法落盘，请检查浏览器存储后重试。')
      return null
    }
    if (internal.failWrites) {
      internal.doc = withWal
      sync()
      pushNotice('error', `写入失败：改动已按所见修订号 R${entry.originRev} 记入待恢复队列，恢复时不会重复生成记录。`)
      return null
    }
    const result = apply(withWal)
    const committed: RevisionDoc = {
      ...result.doc,
      pendingWrites: result.doc.pendingWrites.filter((item) => item.opId !== entry.opId),
    }
    persist(committed)
    internal.doc = committed
    sync()
    if (result.revision) pushNotice('success', describe(result.revision, Boolean(result.merged), (result.conflictedChangeIds?.length ?? 0) > 0))
    return { ...result, doc: committed }
  }

  function commit(
    change: Omit<Change, 'id' | 'actor' | 'at'>,
    note: string,
    baseRev: number = internal.doc.headRev,
    changeId: string = newChangeId(),
  ): Applied | null {
    const input: CommitInput = { baseRev, changeId, actor: internal.actor, note, change }
    return runOp(
      { op: 'commit', input },
      (current) => {
        const outcome = commitRevision(current, input)
        if (!outcome.ok) return { doc: current }
        return { doc: outcome.doc, revision: outcome.revision, merged: outcome.merged, conflictedChangeIds: outcome.conflictedChangeIds }
      },
      (revision, merged, conflicted) =>
        conflicted
          ? `R${revision.rev}：同一项双方都改过，已保留两份来源并标明提交人，请在修订中心裁决。`
          : merged
            ? `R${revision.rev}：检测到对方的并行修订，无冲突内容已自动合并。`
            : `已保存为 R${revision.rev}。`,
    )
  }

  return {
    subscribe,

    // ---- 图谱与课程 ----
    moveNode(id: string, x: number, y: number) {
      internal.doc = { ...internal.doc, layout: { ...internal.doc.layout, [id]: { x, y } } }
      sync()
      try {
        persist(internal.doc)
      } catch {
        // 布局为本地工作区状态，落盘失败不阻断拖拽。
      }
    },
    addMapping(source: string, target: string, relation: Mapping['relation'], weight: number) {
      if (source === target) return null
      const mapping: Mapping = { id: `M-${Date.now()}`, source, target, relation, weight }
      return commit({ kind: 'mapping-add', mapping }, `新增映射 ${source} → ${target}（${relation}）`)
    },
    saveNode(node: GraphNode) {
      return commit({ kind: 'node-upsert', node }, `修订节点 ${node.id}：${node.label.split('\n')[0]}`)
    },

    // ---- 改革审阅 ----
    attachSubmittedReview(input: {
      id: string
      courseId: string
      requirementId: string
      evidence: string
      revisionNote: string
      submitter: string
      baseRev: number
      changeId: string
    }) {
      const review: ReviewItem = {
        id: input.id,
        courseId: input.courseId,
        requirementId: input.requirementId,
        evidence: input.evidence,
        submitter: input.submitter,
        status: '待审阅',
        comment: '',
      }
      return commit({ kind: 'review-submit', review, note: input.revisionNote }, input.revisionNote, input.baseRev, input.changeId)
    },
    decideReview(id: string, status: Extract<ReviewItem['status'], '已附议' | '已退回'>, comment: string) {
      const review = workingSnapshot(internal.doc).reviewItems.find((item) => item.id === id)
      if (!review) return null
      return commit({ kind: 'review-decision', review, decision: { status, comment } }, `审阅 ${id}：${status}`)
    },
    resubmitReview(id: string, evidence: string, note: string) {
      const review = workingSnapshot(internal.doc).reviewItems.find((item) => item.id === id)
      if (!review) return null
      const next: ReviewItem = { ...review, evidence, status: '待审阅', comment: '', lockedRev: undefined }
      return commit({ kind: 'review-submit', review: next, note }, `补充证据重新提交 ${id}：${note}`)
    },
    bulkDecide(ids: string[], status: Extract<ReviewItem['status'], '已附议' | '已退回'>, comment: string) {
      ids.forEach((id) => this.decideReview(id, status, comment))
    },

    // ---- 冲突裁决 ----
    adopt(conflictId: string, variant: 'head' | 'incoming') {
      const walOpId = newChangeId()
      return runOp(
        { op: 'adopt', conflictId, variant, actor: internal.actor, walOpId },
        (current) => {
          const result = adoptConflict(current, conflictId, variant, internal.actor, walOpId)
          if (!result.ok || !result.doc) return { doc: current }
          return { doc: result.doc, revision: result.revision }
        },
        (revision) => `冲突裁决完成，已保存为 R${revision.rev}。`,
      )
    },

    // ---- 发布锁版 ----
    publish(note: string) {
      const walOpId = newChangeId()
      return runOp(
        { op: 'release', note, actor: internal.actor, walOpId },
        (current) => {
          const result = publishRelease(current, note, internal.actor, walOpId)
          return { doc: result.doc, revision: result.revision }
        },
        () => '已发布锁版：仅纳入已采用（附议）的修改，退回与待审阅项仍留在队列，历史版本可查。',
      )
    },

    // ---- 失败恢复 ----
    recover() {
      if (internal.doc.pendingWrites.length === 0) {
        pushNotice('info', '当前没有待恢复的写入。')
        return
      }
      let current = internal.doc
      let recovered = 0
      let skipped = 0
      for (const pending of [...current.pendingWrites]) {
        const result = replayPending(current, pending)
        current = result.doc
        if (result.skipped) skipped += 1
        else if (result.revision) recovered += 1
        current = { ...current, pendingWrites: current.pendingWrites.filter((item) => item.opId !== pending.opId) }
      }
      internal.failWrites = false
      try {
        persist(current)
        internal.doc = current
        sync()
        pushNotice('success', `已按修订号恢复 ${recovered} 条写入${skipped ? `，${skipped} 条因记录已存在被跳过` : ''}，无重复记录。`)
      } catch {
        internal.doc = current
        sync()
        pushNotice('error', '恢复重放已完成但落盘仍失败，请稍后再次点击恢复。')
      }
    },

    // ---- 草稿 / 历史视图 / 操作人 / 故障模拟 ----
    saveDraft(draft: string) {
      internal.doc = { ...internal.doc, draft }
      sync()
      try {
        persist(internal.doc)
      } catch {
        // 草稿落盘失败不阻断编辑。
      }
    },
    viewAt(rev: number | null) {
      internal.viewRev = rev
      sync()
    },
    setActor(name: string, role: Role) {
      internal.actor = { name, role }
      if (browser) localStorage.setItem(ACTOR_KEY, JSON.stringify(internal.actor))
      sync()
    },
    setFailWrites(value: boolean) {
      internal.failWrites = value
      sync()
      pushNotice(value ? 'info' : 'success', value ? '已模拟写入故障：下一次提交会落入待恢复队列。' : '写入故障模拟已关闭。')
    },
    pushNotice,
    dismissNotice,
    newChangeId,
  }
}

export const curriculumStore = createCurriculumStore()

export function validateCurriculum(state: Pick<CurriculumView, 'nodes' | 'mappings'>) {
  const issues: Array<{ id: string; severity: '错误' | '警告'; title: string; detail: string }> = []
  const outgoing = new Map<string, Mapping[]>()
  state.mappings.forEach((mapping) => {
    outgoing.set(mapping.source, [...(outgoing.get(mapping.source) ?? []), mapping])
  })
  state.nodes
    .filter((node) => node.type === '毕业要求')
    .forEach((node) => {
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
