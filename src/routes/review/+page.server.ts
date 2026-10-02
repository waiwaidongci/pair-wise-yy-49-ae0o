import { fail } from '@sveltejs/kit'
import { revisionSchema } from '$lib/schema'

export const actions = {
  submitRevision: async ({ request }) => {
    const form = await request.formData()
    const parsed = revisionSchema.safeParse({
      courseId: form.get('courseId'),
      requirementId: form.get('requirementId'),
      evidence: form.get('evidence'),
      revisionNote: form.get('revisionNote'),
      submitter: form.get('submitter'),
      baseRev: form.get('baseRev'),
      changeId: form.get('changeId'),
    })
    if (!parsed.success) {
      return fail(400, { errors: parsed.error.flatten().fieldErrors, values: Object.fromEntries(form) })
    }
    // 以客户端幂等标识派生条目号，避免双方同时提交时时间戳撞号导致误判冲突。
    const item = {
      id: `REV-${parsed.data.changeId.replace(/[^a-zA-Z0-9]/g, '').slice(-8)}`,
      courseId: parsed.data.courseId,
      requirementId: parsed.data.requirementId,
      // 证据与版本说明分离保留，便于旧版比对与冲突并列。
      evidence: parsed.data.evidence,
      revisionNote: parsed.data.revisionNote,
      submitter: parsed.data.submitter,
      status: '待审阅' as const,
      comment: '',
      baseRev: parsed.data.baseRev,
      changeId: parsed.data.changeId,
    }
    return { success: true, item }
  },
}
