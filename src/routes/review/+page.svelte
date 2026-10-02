<script lang="ts">
  import { curriculumStore } from '$lib/stores'
  let selectedIds = $state<string[]>([])
  let reviewComments = $state<Record<string, string>>({})
  let submitter = $state('')
  let revisionNote = $state('')
  let submitting = $state(false)
  let notice = $state<{ type: 'success' | 'error'; text: string } | null>(null)

  const pending = $derived($curriculumStore.reviewItems.filter((item) => item.status === '待审阅'))
  const courseNames = $derived($curriculumStore.nodes.filter((node) => node.type === '课程'))
  const requirements = $derived($curriculumStore.nodes.filter((node) => node.type === '毕业要求'))
  const pendingOpsCount = $derived($curriculumStore.pendingOps.length)
  const conflicts = $derived($curriculumStore.conflicts)

  async function submitReviewForm(event: Event) {
    event.preventDefault()
    const form = event.target as HTMLFormElement
    const data = new FormData(form)
    const courseId = String(data.get('courseId'))
    const requirementId = String(data.get('requirementId'))
    const evidence = String(data.get('evidence'))
    const note = String(data.get('revisionNote'))
    const who = String(data.get('submitter'))
    if (!courseId || !requirementId || !evidence || !note || !who) {
      notice = { type: 'error', text: '请填写完整的修订信息。' }
      return
    }
    submitting = true
    curriculumStore.addReview({ courseId, requirementId, evidence: `${evidence} 修订说明：${note}`, submitter: who })
    const result = await curriculumStore.submitRevision(who, note)
    submitting = false
    if (result.ok) {
      notice = { type: 'success', text: `修订已提交（R${result.head}），进入院系审阅队列。${result.duplicate ? '（幂等命中，未重复生成记录）' : ''}` }
      form.reset()
    } else {
      notice = { type: 'error', text: '提交失败，修订已保留在本地，重开后自动恢复。' }
    }
  }

  async function review(item: (typeof $curriculumStore.reviewItems)[number], status: '已附议' | '已退回') {
    const comment = reviewComments[item.id] || (status === '已附议' ? '证据充分，同意纳入修订。' : '请补充可验证的评分记录。')
    curriculumStore.updateReview(item.id, status, comment)
    const result = await curriculumStore.submitRevision('院系审阅人', `审阅意见：${status}`)
    if (result.ok) {
      notice = { type: 'success', text: `审阅意见已提交（R${result.head}）。` }
    } else {
      notice = { type: 'error', text: '提交失败，意见已保留，重开后自动恢复。' }
    }
  }

  async function bulkApprove() {
    const ids = [...selectedIds]
    ids.forEach((id) => {
      const item = $curriculumStore.reviewItems.find((entry) => entry.id === id)
      if (item) curriculumStore.updateReview(id, '已附议', '批量附议：证据链完整。')
    })
    selectedIds = []
    const result = await curriculumStore.submitRevision('院系审阅人', `批量附议 ${ids.length} 项`)
    if (result.ok) notice = { type: 'success', text: `批量附议已提交（R${result.head}）。` }
  }
</script>

<svelte:head><title>课程改革审阅</title></svelte:head>

<section class="page">
  <div class="page-head">
    <div><p class="eyebrow">REFORM REVIEW / 改革审阅</p><h1>修订提交与逐项审阅</h1><p class="muted">每次提交带上所见版本，未冲突直接合用，冲突保留两份并标明来源。</p></div>
    <div class="actions">
      <span class="rev-badge">所见版本 R{$curriculumStore.base}</span>
      <span class="rev-badge muted">待提交 {$curriculumStore.pendingOps.length}</span>
      <button class="btn-secondary" disabled={selectedIds.length === 0} onclick={bulkApprove}>批量附议 {selectedIds.length ? `(${selectedIds.length})` : ''}</button>
      <button class="btn-secondary" onclick={() => window.print()}>打印审阅单</button>
    </div>
  </div>

  {#if notice}
    <div class="notice {notice.type}">{notice.text}</div>
  {/if}

  {#if conflicts.length > 0}
    <div class="conflict-bar">
      <strong>检测到 {conflicts.length} 项冲突，已保留双方修改：</strong>
      {#each conflicts as c}
        <span class="conflict-chip">{c.targetLabel}（{c.incomingOrigin} ↔ {c.existingOrigin}）</span>
      {/each}
    </div>
  {/if}

  <div class="review-layout">
    <section class="panel">
      <div class="panel-head"><h3>审阅队列</h3><span class="muted">{pending.length} 项待处理 · 退回项留在队列</span></div>
      <div class="review-list">
        {#each $curriculumStore.reviewItems as item}
          <article class:selected={selectedIds.includes(item.id)} class:conflicted={item.conflictOf}>
            <div class="select"><input type="checkbox" checked={selectedIds.includes(item.id)} onchange={(event) => selectedIds = event.currentTarget.checked ? [...selectedIds, item.id] : selectedIds.filter((id) => id !== item.id)} /></div>
            <div class="review-main">
              <div class="review-title">
                <strong>{item.id} · {courseNames.find((node) => node.id === item.courseId)?.label.split('\n')[0]}</strong>
                <span class:approved={item.status === '已附议'} class:returned={item.status === '已退回'}>{item.status}</span>
              </div>
              <p>{item.evidence}</p>
              <small>对应 {requirements.find((node) => node.id === item.requirementId)?.label.split('\n')[0]} · {item.submitter} 提交{#if item.origin} · 来源 {item.origin}{/if}{#if item.conflictOf} · 冲突副本（原 {item.conflictOf}）{/if}</small>
              {#if item.status === '待审阅'}
                <div class="review-actions">
                  <input bind:value={reviewComments[item.id]} placeholder="填写附议或退回意见" />
                  <button class="btn-primary" onclick={() => review(item, '已附议')}>附议</button>
                  <button class="btn-danger" onclick={() => review(item, '已退回')}>退回补充</button>
                </div>
              {:else}
                <div class:returned={item.status === '已退回'} class="decision">审阅意见：{item.comment}</div>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    </section>

    <aside class="panel">
      <div class="panel-head"><h3>提交课程修订</h3><span class="muted">所见 R{$curriculumStore.base}</span></div>
      <form onsubmit={submitReviewForm}>
        <label>课程<select name="courseId">{#each courseNames as course}<option value={course.id}>{course.id} · {course.label.split('\n')[0]}</option>{/each}</select></label>
        <label>毕业要求<select name="requirementId">{#each requirements as requirement}<option value={requirement.id}>{requirement.id} · {requirement.label.split('\n')[0]}</option>{/each}</select></label>
        <label>证据说明<textarea name="evidence" rows="4" placeholder="说明教学活动、考核记录与达成证据"></textarea></label>
        <label>修订说明<textarea name="revisionNote" rows="3" placeholder="说明本轮为什么调整映射或证据"></textarea></label>
        <label>提交人<input name="submitter" placeholder="课程负责人姓名" bind:value={submitter} /></label>
        <button class="btn-primary" type="submit" disabled={submitting}>{submitting ? '提交中…' : '提交修订（进入审阅队列）'}</button>
      </form>
      <div class="version-compare">
        <strong>修订说明（双方修改保留两份）</strong>
        {#each $curriculumStore.draftVersions.slice(-4) as v}
          <div><span>[{v.origin}]</span><b>{v.text.slice(0, 24)}{v.text.length > 24 ? '…' : ''}</b></div>
        {/each}
        {#if $curriculumStore.draftVersions.length === 0}<div><span class="muted">暂无版本说明</span></div>{/if}
      </div>
    </aside>
  </div>
</section>

<style>
  .actions { display: flex; gap: 8px; align-items: center; }
  .rev-badge { padding: 5px 10px; border-radius: 6px; color: #2f6f72; background: #e7f2f1; font-size: 12px; font-weight: 700; }
  .rev-badge.muted { color: #748289; background: #eef1f1; font-weight: 500; }
  .notice { margin-bottom: 12px; padding: 12px 14px; border-left: 3px solid #3f8869; color: #27634d; background: #ebf6f0; }
  .notice.error { border-color: #bd4d35; color: #913c2b; background: #fff1ec; }
  .conflict-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; padding: 10px 14px; border-left: 3px solid #cd813a; background: #fff6e9; font-size: 12px; }
  .conflict-chip { padding: 3px 8px; border-radius: 5px; color: #9b5a25; background: #ffe6cc; font-size: 11px; }
  .review-layout { display: grid; grid-template-columns: minmax(0,1fr) 360px; gap: 14px; align-items: start; }
  .review-list { padding: 8px 16px 16px; }
  .review-list article { display: grid; grid-template-columns: 28px minmax(0,1fr); gap: 9px; padding: 14px 0; border-bottom: 1px solid #e8eded; }
  .review-list article.selected { background: #f4f8f7; }
  .review-list article.conflicted { background: #fffaf3; }
  .review-title { display: flex; justify-content: space-between; gap: 10px; }
  .review-title span { padding: 3px 6px; border-radius: 5px; color: #9b5a25; background: #fff0de; font-size: 10px; }
  .review-title span.approved { color: #2e7359; background: #e7f4ec; }
  .review-title span.returned { color: #a94331; background: #ffebe6; }
  .review-main p { margin: 7px 0; color: #5f6e74; font-size: 12px; line-height: 1.55; }
  .review-main small { color: #839096; }
  .review-actions { display: flex; gap: 7px; margin-top: 10px; }
  .review-actions input { flex: 1; }
  .decision { margin-top: 9px; padding: 8px; color: #2f6f58; background: #edf7f1; font-size: 11px; }
  .decision.returned { color: #a54431; background: #fff0ec; }
  form { display: grid; gap: 12px; padding: 16px; }
  form button { margin-top: 3px; }
  .version-compare { margin: 0 16px 16px; padding: 12px; border: 1px solid #dbe3e3; border-radius: 8px; background: #f6f8f7; }
  .version-compare strong { display: block; margin-bottom: 9px; font-size: 12px; }
  .version-compare div { display: flex; justify-content: space-between; gap: 8px; padding: 5px 0; color: #66757b; font-size: 10px; }
  .version-compare b { color: #2e7359; }
  @media (max-width: 1050px) { .review-layout { grid-template-columns: 1fr; } }
</style>
