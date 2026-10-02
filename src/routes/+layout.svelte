<script lang="ts">
  import { page } from '$app/state'
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query'
  import { curriculumStore } from '$lib/stores'
  import type { Role } from '$lib/revision'
  import '../app.css'
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
  })
  let { children } = $props()
  let mobileOpen = $state(false)
  const nav = [
    { href: '/', label: '建设总览', icon: '总' },
    { href: '/courses', label: '课程与单元', icon: '课' },
    { href: '/matrix', label: '映射图谱', icon: '图' },
    { href: '/review', label: '改革审阅', icon: '审' },
  ]
  const roles: Role[] = ['课程负责人', '院系审阅人']
  const conflictCount = $derived($curriculumStore.conflicts.filter((conflict) => !conflict.resolved).length)
</script>

<svelte:head><title>{page.data?.title ?? '课程改革审阅平台'}</title></svelte:head>

<QueryClientProvider client={queryClient}>
  <div class="shell">
    <aside class:open={mobileOpen}>
      <div class="brand"><div class="brand-mark">课改</div><div><strong>课程标准映射</strong><small>计算机科学与技术专业</small></div></div>
      <nav>
        {#each nav as item}
          <a href={item.href} class:active={page.url.pathname === item.href} onclick={() => mobileOpen = false}><span>{item.icon}</span>{item.label}</a>
        {/each}
      </nav>
      <div class="actor-box">
        <label>当前操作人
          <input value={$curriculumStore.actor.name} onchange={(event) => curriculumStore.setActor(event.currentTarget.value || $curriculumStore.actor.name, $curriculumStore.actor.role)} />
        </label>
        <label>角色
          <select value={$curriculumStore.actor.role} onchange={(event) => curriculumStore.setActor($curriculumStore.actor.name, event.currentTarget.value as Role)}>
            {#each roles as role}<option value={role}>{role}</option>{/each}
          </select>
        </label>
      </div>
      <div class="side-note">
        <strong>{$curriculumStore.isLockedView ? '锁版快照（只读）' : $curriculumStore.readonly ? '历史版本（只读）' : $curriculumStore.lastReleaseRev ? '已发布锁版 · 继续修订' : '草稿自动保存'}</strong>
        <span>{$curriculumStore.readonly ? `查看 R${$curriculumStore.rev} / 工作版 R${$curriculumStore.headRev}` : `当前工作版 R${$curriculumStore.rev}`}{#if conflictCount > 0} · {conflictCount} 项冲突{/if}</span>
        {#if $curriculumStore.pendingWrites.length > 0}
          <a class="pending-link" href="/review">{$curriculumStore.pendingWrites.length} 条写入待恢复 →</a>
        {/if}
      </div>
    </aside>
    <main>
      <header class="mobile-header"><button onclick={() => mobileOpen = !mobileOpen}>菜单</button><strong>{page.data?.title ?? '课程标准映射'}</strong></header>

      {#if $curriculumStore.viewRev !== null}
        <div class="view-banner">
          正在查看 R{$curriculumStore.viewRev}{$curriculumStore.isLockedView ? ' 锁版快照' : ' 历史版本'}（只读）：{$curriculumStore.viewing?.note}
          <button class="btn-secondary" onclick={() => curriculumStore.viewAt(null)}>回到当前工作版 R{$curriculumStore.headRev}</button>
        </div>
      {/if}

      <div class="notice-stack">
        {#each $curriculumStore.notices as notice (notice.id)}
          <div class="notice-line {notice.tone}">
            <span>{notice.text}</span>
            <button onclick={() => curriculumStore.dismissNotice(notice.id)}>×</button>
          </div>
        {/each}
      </div>

      {@render children()}
    </main>
  </div>
</QueryClientProvider>

<style>
  .shell { min-height: 100vh; background: #f1f4f3; }
  aside { position: fixed; inset: 0 auto 0 0; z-index: 20; display: flex; width: 242px; flex-direction: column; color: #e8f0f1; background: #264a52; }
  .brand { display: flex; align-items: center; gap: 11px; padding: 20px 16px; border-bottom: 1px solid rgba(255,255,255,.1); }
  .brand-mark { display: grid; width: 42px; height: 42px; place-items: center; border: 1px solid #79b0ac; border-radius: 9px; color: #b5e1dc; font-size: 13px; font-weight: 800; }
  .brand strong, .brand small { display: block; }
  .brand strong { font-size: 14px; }
  .brand small { margin-top: 4px; color: #9bb1b4; font-size: 10px; }
  nav { display: grid; gap: 5px; padding: 16px 10px; }
  nav a { display: flex; align-items: center; gap: 10px; padding: 11px 12px; border-radius: 7px; color: #bed0d2; text-decoration: none; font-size: 13px; }
  nav a.active { color: white; background: #365e64; box-shadow: inset 3px 0 #74bcb4; }
  nav a span { display: grid; width: 24px; height: 24px; place-items: center; border: 1px solid rgba(255,255,255,.2); border-radius: 5px; font-size: 11px; }
  .actor-box { display: grid; gap: 8px; padding: 0 12px 12px; border-bottom: 1px solid rgba(255,255,255,.1); }
  .actor-box label { display: grid; gap: 5px; color: #9eb2b5; font-size: 10px; }
  .actor-box input, .actor-box select { padding: 7px 8px; font-size: 12px; }
  .side-note { margin: auto 12px 14px; padding: 12px; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; background: rgba(255,255,255,.04); }
  .side-note strong, .side-note span { display: block; font-size: 11px; }
  .side-note span { margin-top: 5px; color: #9eb2b5; }
  .pending-link { display: inline-block; margin-top: 7px; color: #ffc9a8; font-size: 11px; }
  main { min-width: 0; margin-left: 242px; }
  .mobile-header { display: none; }
  .view-banner { display: flex; align-items: center; gap: 12px; padding: 9px 22px; color: #7a541f; background: #fdeed3; border-bottom: 1px solid #f0d39a; font-size: 12px; }
  .view-banner button { margin-left: auto; padding: 5px 10px; }
  .notice-stack { position: sticky; top: 0; z-index: 30; display: grid; gap: 6px; padding: 8px 22px 0; pointer-events: none; }
  .notice-line { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 13px; border-radius: 8px; font-size: 12px; box-shadow: 0 6px 18px rgba(29,56,64,.12); pointer-events: auto; }
  .notice-line.success { color: #27634d; background: #e8f5ee; border: 1px solid #b9dfcb; }
  .notice-line.info { color: #315e68; background: #e8f2f4; border: 1px solid #bcd7dc; }
  .notice-line.error { color: #913c2b; background: #fdeee9; border: 1px solid #efc2b3; }
  .notice-line button { border: 0; background: transparent; font-size: 15px; cursor: pointer; color: inherit; }
  @media (max-width: 800px) {
    aside { left: -260px; transition: left .18s ease; }
    aside.open { left: 0; }
    main { margin-left: 0; }
    .mobile-header { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; min-height: 52px; padding: 8px 12px; color: white; background: #264a52; }
    .mobile-header button { padding: 6px 10px; border: 1px solid #6f9699; border-radius: 6px; color: white; background: transparent; }
  }
</style>
