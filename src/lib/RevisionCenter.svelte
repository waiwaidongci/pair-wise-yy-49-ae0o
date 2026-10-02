<script lang="ts">
  import { curriculumStore } from '$lib/stores'
  import { describeEntity, isRelease, type ChangeKind } from '$lib/revision'

  type VariantKey = 'head' | 'incoming'
  let { expanded = true }: { expanded?: boolean } = $props()

  const view = $derived($curriculumStore)
  const pendingCount = $derived(view.pendingWrites.length)
  const unresolved = $derived(view.conflicts.filter((conflict) => !conflict.resolved))
  const recent = $derived([...view.revisions].reverse().slice(0, 12))

  function kindLabel(kind: ChangeKind): string {
    return { 'node-upsert': '课程节点', 'mapping-add': '映射', 'review-submit': '修订提交', 'review-decision': '审阅意见' }[kind]
  }

  function formatTime(at: string): string {
    try {
      return new Date(at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    } catch {
      return at
    }
  }

  function adopt(conflictId: string, variant: VariantKey) {
    curriculumStore.adopt(conflictId, variant)
  }

  let releaseNote = $state('')
  function publish() {
    const note = releaseNote.trim() || `R${view.headRev + 1} 锁版发布：纳入已采用修改`
    curriculumStore.publish(note)
    releaseNote = ''
  }
</script>

<section class="panel revision-center">
  <div class="panel-head" onclick={() => (expanded = !expanded)} role="button" tabindex="0" onkeydown={(event) => event.key === 'Enter' && (expanded = !expanded)}>
    <h3>修订中心</h3>
    <span class="muted">
      当前工作版 R{view.headRev}{#if view.lastReleaseRev} · 最近锁版 R{view.lastReleaseRev}{/if}
      {#if pendingCount > 0}<b class="badge danger">待恢复 {pendingCount}</b>{/if}
      {#if unresolved.length > 0}<b class="badge warn">冲突 {unresolved.length}</b>{/if}
    </span>
  </div>

  {#if expanded}
    <!-- 写入失败后的恢复 -->
    {#if pendingCount > 0}
      <div class="block recovery">
        <strong>写入失败，待按修订号恢复</strong>
        <p class="muted">以下改动已记入待恢复队列，恢复时依据修订号重放；已存在的记录会被跳过，不会重复生成。</p>
        <ul>
          {#each view.pendingWrites as pending}
            <li>
              <span>R{pending.originRev} · {formatTime(pending.at)}</span>
              {#if pending.payload.op === 'commit'}
                <b>{pending.payload.input.change.kind} · {pending.payload.input.note ?? pending.payload.input.changeId}</b>
              {:else if pending.payload.op === 'release'}
                <b>发布锁版 · {pending.payload.note}</b>
              {:else}
                <b>冲突裁决 · {pending.payload.conflictId}</b>
              {/if}
            </li>
          {/each}
        </ul>
        <button class="btn-primary" onclick={() => curriculumStore.recover()}>按修订号恢复全部</button>
      </div>
    {/if}

    <!-- 双方都改过同一项：保留两份来源 -->
    {#if view.conflicts.length > 0}
      <div class="block">
        <strong>同项双改 · 并列保留</strong>
        <div class="conflict-list">
          {#each view.conflicts as conflict (conflict.id)}
            <article class:resolved={conflict.resolved}>
              <header>
                <b>{kindLabel(conflict.kind)} · {describeEntity(view.doc, conflict.kind, conflict.entityId)}</b>
                {#if conflict.resolved}
                  <span class="tag approved">R{conflict.resolved.rev} 已采用{conflict.resolved.variant === 'head' ? '当前版本' : '后提交版本'}</span>
                {:else}
                  <span class="tag returned">待裁决</span>
                {/if}
              </header>
              {#if !conflict.resolved}
                <div class="variants">
                  <div class="variant">
                    <small>当前版本 · {conflict.head.actor.name}（{conflict.head.actor.role}）· R{conflict.head.rev}</small>
                    <p>{conflict.head.value}</p>
                    <button class="btn-secondary" onclick={() => adopt(conflict.id, 'head')}>采用此份</button>
                  </div>
                  <div class="variant incoming">
                    <small>后提交版本 · {conflict.incoming.actor.name}（{conflict.incoming.actor.role}）· 基于 R{conflict.mergedAtRev}</small>
                    <p>{conflict.incoming.value}</p>
                    <button class="btn-secondary" onclick={() => adopt(conflict.id, 'incoming')}>采用此份</button>
                  </div>
                </div>
              {:else}
                <p class="muted resolved-note">{conflict.resolved.note} · {conflict.resolved.actor.name} · {formatTime(conflict.resolved.at)}</p>
              {/if}
            </article>
          {/each}
        </div>
      </div>
    {/if}

    <!-- 发布锁版：只纳入已采用的修改 -->
    <div class="block publish">
      <strong>发布锁版</strong>
      <p class="muted">仅已附议（采用）的修订进入锁版快照；退回项仍留在审阅队列，可补充证据后重新提交。</p>
      <div class="publish-row">
        <input bind:value={releaseNote} placeholder={`版本说明，例如：R${view.headRev + 1} 纳入 C-308 证据修订`} />
        <button class="btn-primary" onclick={publish} disabled={view.readonly}>锁定发布 R{view.headRev + 1}</button>
      </div>
    </div>

    <!-- 修订日志与旧版查看 -->
    <div class="block">
      <strong>修订日志 · 旧版可查</strong>
      <div class="rev-list">
        {#each recent as revision}
          <button class="rev-row" class:current={view.viewRev === revision.rev} onclick={() => curriculumStore.viewAt(view.viewRev === revision.rev ? null : revision.rev)}>
            <span class="rev-no">R{revision.rev}</span>
            <span class:release-tag={revision.kind === 'release'} class="kind-tag">{revision.kind === 'init' ? '首版' : revision.kind === 'release' ? '锁版' : `基于 R${revision.baseRev}`}</span>
            <span class="rev-note">{revision.note}</span>
            <small>{revision.actor ? `${revision.actor.name}` : '系统'}</small>
            <small>{formatTime(revision.at)}</small>
          </button>
        {/each}
      </div>
      {#if view.viewRev !== null}
        <div class="viewing-bar">
          正在查看 <b>R{view.viewRev}</b>{isRelease(view.doc, view.viewRev) ? ' 锁版快照' : ' 工作版本'}，内容只读。
          <button class="btn-secondary" onclick={() => curriculumStore.viewAt(null)}>回到当前工作版 R{view.headRev}</button>
        </div>
      {/if}
    </div>

    <!-- 故障模拟 -->
    <div class="block ops">
      <label class="switch-row">
        <input type="checkbox" checked={view.failWrites} onchange={(event) => curriculumStore.setFailWrites(event.currentTarget.checked)} />
        <span>模拟写入失败（下一次提交进入待恢复队列，重新打开页面后自动按修订号恢复）</span>
      </label>
    </div>
  {/if}
</section>

<style>
  .revision-center { margin-top: 14px; }
  .panel-head { cursor: pointer; }
  .badge { margin-left: 8px; padding: 2px 7px; border-radius: 10px; font-size: 10px; font-weight: 800; }
  .badge.danger { color: #a94331; background: #ffebe6; }
  .badge.warn { color: #9b5a25; background: #fff0de; }
  .block { padding: 14px 16px; border-bottom: 1px solid #edf0f0; }
  .block > strong { display: block; margin-bottom: 8px; font-size: 13px; }
  .recovery { background: #fff7f5; }
  .recovery ul { display: grid; gap: 6px; margin: 8px 0 10px; padding: 0; list-style: none; }
  .recovery li { display: grid; grid-template-columns: 90px 1fr; gap: 8px; font-size: 11px; }
  .recovery li span { color: #a94331; font-weight: 700; }
  .conflict-list { display: grid; gap: 10px; }
  .conflict-list article { border: 1px solid #f0d9cf; border-radius: 8px; padding: 10px 12px; background: #fffaf8; }
  .conflict-list article.resolved { border-color: #cfe5d8; background: #f6fbf8; }
  .conflict-list header { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; }
  .variants { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; margin-top: 9px; }
  .variant { padding: 9px 10px; border: 1px dashed #d9a08e; border-radius: 7px; background: white; }
  .variant.incoming { border-color: #c98fb0; background: #fdf7fb; }
  .variant small { display: block; color: #8a6a5c; font-size: 10px; }
  .variant p { margin: 6px 0 8px; color: #4c5b61; font-size: 11px; line-height: 1.5; }
  .resolved-note { margin: 7px 0 0; font-size: 11px; }
  .tag { padding: 2px 7px; border-radius: 9px; font-size: 10px; }
  .tag.returned { color: #a94331; background: #ffebe6; }
  .tag.approved { color: #2e7359; background: #e7f4ec; }
  .publish-row { display: flex; gap: 8px; margin-top: 9px; }
  .rev-list { display: grid; gap: 4px; max-height: 240px; overflow: auto; }
  .rev-row { display: grid; grid-template-columns: 42px 64px 1fr auto auto; gap: 8px; align-items: center; padding: 7px 9px; border: 1px solid #e4e9e9; border-radius: 6px; background: white; text-align: left; cursor: pointer; font-size: 11px; }
  .rev-row.current { border-color: #2f6f72; background: #eef6f5; }
  .rev-no { font-weight: 800; color: #2f6f72; }
  .kind-tag { color: #7c8a90; font-size: 10px; }
  .release-tag { color: #9b5a25; font-weight: 700; }
  .rev-note { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #4c5b61; }
  .rev-row small { color: #93a0a5; }
  .viewing-bar { display: flex; align-items: center; gap: 10px; margin-top: 10px; padding: 9px 11px; border-left: 3px solid #2f6f72; background: #eef6f5; font-size: 12px; }
  .ops { border-bottom: 0; }
  .switch-row { display: flex; grid-template-columns: none; align-items: center; gap: 9px; font-weight: 400; font-size: 11px; color: #6c787d; }
  .switch-row input { width: auto; }
</style>
