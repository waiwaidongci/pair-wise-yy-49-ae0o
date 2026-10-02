import { json } from '@sveltejs/kit'
import { z } from 'zod'
import { publishRevision } from '$lib/server/revisionStore'

const publishSchema = z.object({
  number: z.number().int().min(1),
})

/** 发布锁版：只纳入已采用的修改，退回项仍留在队列。 */
export async function POST({ request }) {
  const body = await request.json().catch(() => null)
  const parsed = publishSchema.safeParse(body)
  if (!parsed.success) {
    return json({ ok: false, errors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }
  const result = await publishRevision(parsed.data.number)
  return json(result)
}
