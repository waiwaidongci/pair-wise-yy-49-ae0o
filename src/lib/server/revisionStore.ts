import { promises as fs } from 'fs'
import path from 'path'
import { seedState } from '$lib/seed'
import {
  deriveState,
  derivePublishedState,
  mergeOps,
  migrateLegacy,
  now,
  type CurriculumState,
  type Op,
  type Revision,
} from '$lib/revision'

const DATA_DIR = path.join(process.cwd(), '.data')
const DATA_FILE = path.join(DATA_DIR, 'revisions.json')

type StoreData = {
  revisions: Revision[]
  /** 幂等键 -> 修订号，防止重试/重开重复生成记录 */
  idempotencyKeys: Record<string, number>
  /** 已发布（锁版）到的修订号 */
  publishedUpTo: number
}

let cache: StoreData | null = null

async function load(): Promise<StoreData> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf-8')
    cache = JSON.parse(raw) as StoreData
  } catch {
    // 首次运行：旧数据兼容升级为首版 R1
    cache = {
      revisions: migrateLegacy(seedState),
      idempotencyKeys: {},
      publishedUpTo: 0,
    }
    await save()
  }
  return cache
}

async function save(): Promise<void> {
  if (!cache) return
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(DATA_FILE, JSON.stringify(cache, null, 2), 'utf-8')
}

function headNumberOf(revisions: Revision[]): number {
  return revisions.reduce((max, r) => Math.max(max, r.number), 0)
}

export type SubmitInput = {
  base: number
  ops: Op[]
  submitter: string
  note: string
  idempotencyKey: string
}

export type SubmitResult = {
  ok: boolean
  duplicate: boolean
  head: number
  revision: Revision | null
  conflicts: ReturnType<typeof mergeOps>['conflicts']
}

/** 提交一次修订：三路合并，未冲突直接合用，冲突保留两份并标明来源。 */
export async function submitRevision(input: SubmitInput): Promise<SubmitResult> {
  const d = await load()
  const head = headNumberOf(d.revisions)

  // 幂等：同一把钥匙只生成一条记录
  const existing = d.idempotencyKeys[input.idempotencyKey]
  if (existing !== undefined) {
    const rev = d.revisions.find((r) => r.number === existing) ?? null
    return { ok: true, duplicate: true, head: existing, revision: rev, conflicts: [] }
  }

  const base = Math.min(Math.max(0, input.base), head)
  const { ops: mergedOps, conflicts } = mergeOps(d.revisions, base, input.ops, input.submitter)

  const revision: Revision = {
    number: head + 1,
    label: `R${head + 1}`,
    parent: head,
    base,
    at: now(),
    submitter: input.submitter,
    note: input.note,
    ops: mergedOps,
    published: false,
  }

  d.revisions.push(revision)
  d.idempotencyKeys[input.idempotencyKey] = revision.number
  await save()

  return { ok: true, duplicate: false, head: revision.number, revision, conflicts }
}

/** 发布锁版：只纳入已采用的修改。 */
export async function publishRevision(number: number): Promise<{ ok: boolean; publishedUpTo: number }> {
  const d = await load()
  const target = d.revisions.find((r) => r.number === number)
  if (!target) return { ok: false, publishedUpTo: d.publishedUpTo }
  d.publishedUpTo = number
  d.revisions.forEach((r) => {
    if (r.number <= number) r.published = true
  })
  await save()
  return { ok: true, publishedUpTo: d.publishedUpTo }
}

export async function getHead(): Promise<number> {
  const d = await load()
  return headNumberOf(d.revisions)
}

export async function getState(): Promise<CurriculumState & { head: number; publishedUpTo: number }> {
  const d = await load()
  const head = headNumberOf(d.revisions)
  return { ...deriveState(d.revisions), head, publishedUpTo: d.publishedUpTo }
}

export async function getPublishedState(): Promise<CurriculumState & { head: number; publishedUpTo: number }> {
  const d = await load()
  const head = headNumberOf(d.revisions)
  return { ...derivePublishedState(d.revisions, d.publishedUpTo), head, publishedUpTo: d.publishedUpTo }
}

/** 按修订号恢复：返回该修订号对应的状态（旧版可查）。 */
export async function recoverByRevision(number: number): Promise<(CurriculumState & { head: number; publishedUpTo: number; revision: Revision }) | null> {
  const d = await load()
  const revision = d.revisions.find((r) => r.number === number)
  if (!revision) return null
  const head = headNumberOf(d.revisions)
  return { ...deriveState(d.revisions, number), head, publishedUpTo: d.publishedUpTo, revision }
}

export async function listRevisions(): Promise<Revision[]> {
  const d = await load()
  return [...d.revisions].sort((a, b) => b.number - a.number)
}

export async function getRevision(number: number): Promise<Revision | null> {
  const d = await load()
  return d.revisions.find((r) => r.number === number) ?? null
}
