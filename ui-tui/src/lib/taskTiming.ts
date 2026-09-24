import type { TaskTiming } from '@hermes/shared/gateway-events'

// 单独格式化用于底部计时和历史页脚，超过一小时也保留秒数。
export const taskTimingLabel = (timing: TaskTiming, now = Date.now() / 1000): string => {
  const end = timing.finished_at ?? now

  if (!Number.isFinite(timing.started_at) || !Number.isFinite(end) || end < timing.started_at) {
    return '任务耗时：记录不完整'
  }

  const seconds = Math.round(end - timing.started_at)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const duration = `${h ? `${h}小时` : ''}${m || h ? `${m}分` : ''}${s}秒`

  const suffix =
    ({ waiting: '（后台处理中）', error: '（失败）', interrupted: '（已中断）' } as Record<string, string>)[
      timing.status
    ] ?? ''

  return `${timing.finished_at == null ? '本次任务' : '任务耗时'}：${timing.approximate ? '约 ' : ''}${duration}${suffix}`
}
