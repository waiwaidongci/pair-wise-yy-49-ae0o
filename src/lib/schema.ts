import { z } from 'zod'

export const revisionSchema = z.object({
  courseId: z.string().min(1, '请选择课程'),
  requirementId: z.string().min(1, '请选择毕业要求'),
  evidence: z.string().min(12, '证据说明至少需要 12 个字符'),
  revisionNote: z.string().min(8, '修订说明至少需要 8 个字符'),
  submitter: z.string().min(2, '请填写提交人'),
  // 提交者“所见版本”，服务端用于乐观并发与三路合并。
  baseRev: z.coerce.number().int().positive('缺少所见修订号'),
  // 客户端生成的幂等标识，写入失败重放时不会重复生成记录。
  changeId: z.string().min(1, '缺少修订标识'),
})

export const mappingSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  relation: z.enum(['支撑', '前置', '考核', '教学']),
  weight: z.number().min(0).max(1),
})

export type RevisionInput = z.infer<typeof revisionSchema>
