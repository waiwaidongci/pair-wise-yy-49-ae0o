import { json } from '@sveltejs/kit'
import { z } from 'zod'
import { listRevisions, submitRevision } from '$lib/server/revisionStore'
import type { Op } from '$lib/revision'

const opSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['mapping:add', 'mapping:update', 'mapping:delete', 'review:add', 'review:decision', 'review:comment', 'draft:note', 'node:move']),
  targetId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  origin: z.string().min(1),
  at: z.string().min(1),
})

const submitSchema = z.object({
  base: z.number().int().min(0),
  ops: z.array(opSchema).min(1),
  submitter: z.string().min(1, '请填写提交人'),
  note: z.string().min(1, '请填写修订说明'),
  idempotencyKey: z.string().min(1),
})

export async function GET() {
  const revisions = await listRevisions()
  return json({ revisions })
}

export async function POST({ request }) {
  const body = await request.json().catch(() => null)
  const parsed = submitSchema.safeParse(body)
  if (!parsed.success) {
    return json({ ok: false, errors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }
  const result = await submitRevision(parsed.data as { base: number; ops: Op[]; submitter: string; note: string; idempotencyKey: string })
  return json(result)
}
