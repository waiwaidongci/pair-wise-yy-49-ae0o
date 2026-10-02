import { fail } from '@sveltejs/kit'
import { revisionSchema } from '$lib/schema'
import { submitRevision, getHead } from '$lib/server/revisionStore'
import { newId, now, type Op } from '$lib/revision'

export const actions = {
  submitRevision: async ({ request }) => {
    const form = await request.formData()
    const parsed = revisionSchema.safeParse({
      courseId: form.get('courseId'),
      requirementId: form.get('requirementId'),
      evidence: form.get('evidence'),
      revisionNote: form.get('revisionNote'),
      submitter: form.get('submitter'),
    })
    if (!parsed.success) {
      return fail(400, { errors: parsed.error.flatten().fieldErrors, values: Object.fromEntries(form) })
    }

    const id = `REV-${Date.now().toString().slice(-4)}`
    const op: Op = {
      id: newId('op'),
      type: 'review:add',
      targetId: id,
      payload: {
        id,
        courseId: parsed.data.courseId,
        requirementId: parsed.data.requirementId,
        evidence: `${parsed.data.evidence} 修订说明：${parsed.data.revisionNote}`,
        submitter: parsed.data.submitter,
        status: '待审阅',
        comment: '',
      },
      origin: parsed.data.submitter,
      at: now(),
    }

    const head = await getHead()
    const result = await submitRevision({
      base: head,
      ops: [op],
      submitter: parsed.data.submitter,
      note: parsed.data.revisionNote,
      idempotencyKey: newId('idem'),
    })

    return { success: true, item: { id }, revision: result.revision?.label, duplicate: result.duplicate }
  },
}
