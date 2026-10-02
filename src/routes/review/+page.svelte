<script lang="ts">
  import { enhance } from '$app/forms'
  import type { ActionData } from './$types'
  import { curriculumStore } from '$lib/stores'
  import { newChangeId } from '$lib/revision'
  import RevisionCenter from '$lib/RevisionCenter.svelte'

  let { form }: { form: ActionData } = $props()
  let selectedIds = $state<string[]>([])
  let reviewComments = $state<Record<string, string>>({})
  let resubmitEvidence = $state<Record<string, string>>({})
  let pendingChangeId = $state(newChangeId())

  const view = $derived($curriculumStore)
  const pending = $derived(view.reviewItems.filter((item) => item.status === '待审阅'))
  const courseNames = $derived(view.nodes.filter((node) => node.type === '课程'))
  const requirements = $derived(view.nodes.filter((node) => node.type === '毕业要求'))
  const conflictsByReview = $derived(
    new Map(
      view.conflicts
        .filter((conflict) => !conflict.resolved && (conflict.kind === 'review-submit' || conflict.kind === 'review-decision'))
        .map((conflict) => [conflict.entityId, conflict]),
    ),
  )

  function review(item: (typeof view.reviewItems)[number], status: '已附议' | '已退回') {
    curriculumStore.decideReview(item.id, status, reviewComments[item.id] || (status === '已附议' ? '证据充分，同意纳入修订。' : '请补充可验证的评分记录。'))
  }

  function bulkApprove() {
    curriculumStore.bulkDecide(selectedIds, '已附议', '批量附议：证据链完整。')
    selectedIds = []
  }

  function resubmit(item: (typeof view.reviewItems)[number]) {
    const evidence = (resubmitEvidence[item.id] ?? '').trim()
    if (evidence.length < 12) return
    curriculumStore.resubmitReview(item.id, evidence, evidence.slice(0, 24))
    resubmitEvidence[item.id] = ''
  }
</script>

<svelte:head><title>课程改革审阅</title></svelte:head>

<section class="page">
  <div class="page-head">
    <div>
      <p class="eyebrow">REFORM REVIEW / 改革审阅</p>
      <h1>修订提交与逐项审阅</h1>
      <p class="muted">提交携带所见修订号 R{view.headRev}，无冲突改动自动合用；同一项双方都改则保留两份来源。当前以 <b>{view.actor.name}（{view.actor.role}）</b> 身份操作。</p>
    </div>
    <div class="actions">
      <button class="btn-secondary" disabled={selectedIds.length === 0 || view.readonly} onclick={bulkApprove}>批量附议 {selectedIds.length ? `(${selectedIds.length})` : ''}</button>
      <button class="btn-secondary" onclick={() => window.print()}>打印审阅单</button>
    </div>
  </div>

  {#if form?.success}
    <div class="notice success">修订 {form.item?.id} 已提交，进入院系审阅队列。</div>
  {:else if form?.errors}
    <div class="notice error">表单未通过校验：{Object.values(form.errors).flat().join('；')}</div>
  {/if}

  <div class="review-layout">
    <section class="panel">
      <div class="panel-head"><h3>审阅队列</h3><span class="muted">{pending.length} 项待处理 · 退回项可补证据重提</span></div>
      <div class="review-list">
        {#each view.reviewItems as item}
          {@const conflict = conflictsByReview.get(item.id)}
          <article class:selected={selectedIds.includes(item.id)} class:conflicted={conflict}>
            <div class="select">
              {#if item.status === '待审阅'}
                <input type="checkbox" checked={selectedIds.includes(item.id)} onchange={(event) => selectedIds = event.currentTarget.checked ? [...selectedIds, item.id] : selectedIds.filter((id) => id !== item.id)} />
              {/if}
            </div>
            <div class="review-main">
              <div class="review-title">
                <strong>{item.id} · {courseNames.find((node) => node.id === item.courseId)?.label.split('\n')[0]}</strong>
                <span class:approved={item.status === '已附议'} class:returned={item.status === '已退回'}>
                  {item.status}{#if item.lockedRev != null} · 已纳入 R{item.lockedRev}{/if}
                </span>
              </div>
              <p>{item.evidence}</p>
              <small>对应 {requirements.find((node) => node.id === item.requirementId)?.label.split('\n')[0]} · {item.submitter} 提交</small>

              {#if conflict}
                <div class="conflict-flag">
                  <b>同项双改：已保留两份来源</b>
                  <div class="cf-variant">当前版本（{conflict.head.actor.name}）：{conflict.head.value}</div>
                  <div class="cf-variant alt">后提交（{conflict.incoming.actor.name} · 基于 R{conflict.mergedAtRev}）：{conflict.incoming.value}</div>
                  <small>请到下方“修订中心”选择采用哪一份。</small>
                </div>
              {/if}

              {#if item.status === '待审阅' && !view.readonly}
                <div class="review-actions">
                  <input bind:value={reviewComments[item.id]} placeholder="填写附议或退回意见" />
                  <button class="btn-primary" onclick={() => review(item, '已附议')}>附议</button>
                  <button class="btn-danger" onclick={() => review(item, '已退回')}>退回补充</button>
                </div>
              {:else if item.status === '待审阅'}
                <div class="decision">只读视图：当前 R{view.rev}</div>
              {:else}
                <div class:returned={item.status === '已退回'} class="decision">审阅意见：{item.comment || '（无意见）'}</div>
              {/if}

              {#if item.status === '已退回' && !view.readonly}
                <div class="review-actions resubmit">
                  <input bind:value={resubmitEvidence[item.id]} placeholder="补充可验证的评分记录等证据后重新提交（仍走新修订）" />
                  <button class="btn-primary" onclick={() => resubmit(item)}>补充证据重提</button>
                </div>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    </section>

    <aside class="side-col">
      <section class="panel">
        <div class="panel-head"><h3>提交课程修订</h3><span class="muted">所见 R{view.headRev}</span></div>
        <form
          method="POST"
          action="?/submitRevision"
          use:enhance={() => {
            const changeId = pendingChangeId
            return async ({ result, update }) => {
              // 服务端 Zod 校验通过后，携带所见修订号进入本地修订管道（可能触发三路合并）。
              if (result.type === 'success' && result.data && 'item' in result.data) {
                const item = result.data.item as {
                  id: string
                  courseId: string
                  requirementId: string
                  evidence: string
                  revisionNote: string
                  submitter: string
                  baseRev: number
                  changeId: string
                }
                curriculumStore.attachSubmittedReview({
                  id: item.id,
                  courseId: item.courseId,
                  requirementId: item.requirementId,
                  evidence: item.evidence,
                  revisionNote: item.revisionNote,
                  submitter: item.submitter,
                  baseRev: item.baseRev,
                  changeId,
                })
              }
              await update()
              pendingChangeId = newChangeId()
            }
          }}
        >
          <input type="hidden" name="baseRev" value={view.headRev} />
          <input type="hidden" name="changeId" value={pendingChangeId} />
          <label>课程<select name="courseId">{#each courseNames as course}<option value={course.id}>{course.id} · {course.label.split('\n')[0]}</option>{/each}</select></label>
          <label>毕业要求<select name="requirementId">{#each requirements as requirement}<option value={requirement.id}>{requirement.id} · {requirement.label.split('\n')[0]}</option>{/each}</select></label>
          <label>证据说明<textarea name="evidence" rows="4" placeholder="说明教学活动、考核记录与达成证据（≥12 字）"></textarea></label>
          <label>版本说明<textarea name="revisionNote" rows="3" placeholder="说明本轮为什么调整映射或证据（≥8 字）"></textarea></label>
          <label>提交人<input name="submitter" value={view.actor.name} placeholder="课程负责人姓名" /></label>
          <button class="btn-primary" type="submit" disabled={view.readonly}>提交院系审阅</button>
        </form>
      </section>

      <RevisionCenter />
    </aside>
  </div>
</section>

<style>
  .actions { display: flex; gap: 8px; }
  .notice { margin-bottom: 12px; padding: 12px 14px; border-left: 3px solid #3f8869; color: #27634d; background: #ebf6f0; }
  .notice.error { border-color: #bd4d35; color: #913c2b; background: #fff1ec; }
  .review-layout { display: grid; grid-template-columns: minmax(0,1fr) 380px; gap: 14px; align-items: start; }
  .side-col { display: grid; gap: 14px; }
  .review-list { padding: 8px 16px 16px; }
  .review-list article { display: grid; grid-template-columns: 28px minmax(0,1fr); gap: 9px; padding: 14px 0; border-bottom: 1px solid #e8eded; }
  .review-list article.selected { background: #f4f8f7; }
  .review-list article.conflicted { background: #fdf6f3; }
  .review-title { display: flex; justify-content: space-between; gap: 10px; }
  .review-title span { padding: 3px 6px; border-radius: 5px; color: #9b5a25; background: #fff0de; font-size: 10px; white-space: nowrap; }
  .review-title span.approved { color: #2e7359; background: #e7f4ec; }
  .review-title span.returned { color: #a94331; background: #ffebe6; }
  .review-main p { margin: 7px 0; color: #5f6e74; font-size: 12px; line-height: 1.55; }
  .review-main small { color: #839096; }
  .review-actions { display: flex; gap: 7px; margin-top: 10px; }
  .review-actions input { flex: 1; }
  .review-actions.resubmit { border-top: 1px dashed #e2c9bd; padding-top: 10px; }
  .decision { margin-top: 9px; padding: 8px; color: #2f6f58; background: #edf7f1; font-size: 11px; }
  .decision.returned { color: #a54431; background: #fff0ec; }
  .conflict-flag { margin-top: 10px; padding: 9px 11px; border: 1px solid #e5b39f; border-radius: 7px; background: #fff8f3; font-size: 11px; }
  .conflict-flag b { color: #a0502f; }
  .cf-variant { margin-top: 6px; padding: 6px 8px; border-radius: 5px; background: white; color: #5c5048; }
  .cf-variant.alt { background: #fdf2f8; }
  form { display: grid; gap: 12px; padding: 16px; }
  form button { margin-top: 3px; }
  @media (max-width: 1050px) { .review-layout { grid-template-columns: 1fr; } }
</style>
