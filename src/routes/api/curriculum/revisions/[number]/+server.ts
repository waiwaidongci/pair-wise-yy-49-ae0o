import { json } from '@sveltejs/kit'
import { recoverByRevision } from '$lib/server/revisionStore'

/** 按修订号恢复：旧版可查，写入失败后按修订号恢复。 */
export async function GET({ params }) {
  const number = Number(params.number)
  if (!Number.isInteger(number) || number < 1) {
    return json({ ok: false, error: '修订号无效' }, { status: 400 })
  }
  const result = await recoverByRevision(number)
  if (!result) {
    return json({ ok: false, error: `修订 R${number} 不存在` }, { status: 404 })
  }
  return json({ ok: true, ...result })
}
