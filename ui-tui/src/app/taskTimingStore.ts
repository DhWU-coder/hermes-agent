import type { TaskTiming } from '@hermes/shared/gateway-events'
import { atom } from 'nanostores'

import type { Msg } from '../types.js'

// 按会话恢复计时，计时器不依赖当前一轮 busy 状态或标题的可用宽度。
export const $taskTiming = atom<TaskTiming | null>(null)

export const restoreTaskTiming = (messages: Msg[], timing?: TaskTiming | null) => {
  const timedIndex = messages.findLastIndex(msg => msg.taskTiming)
  const userIndex = messages.findLastIndex(msg => msg.role === 'user')
  $taskTiming.set(timing ?? (timedIndex > userIndex ? messages[timedIndex]?.taskTiming : null) ?? null)
}

export const applyTaskTiming = (messages: Msg[], timing: TaskTiming): Msg[] => {
  const result: Msg[] = messages.map(msg => {
    if (msg.taskTiming?.started_at !== timing.started_at) {
      return msg
    }

    const { taskTiming: _previous, ...rest } = msg

    return rest
  })

  // 后台等待期间不显示“已完成”；只有终止事件才能把页脚附到最终回复。
  if (timing.finished_at != null) {
    const index = result.findLastIndex(msg => msg.role === 'assistant' && !msg.kind)
    const userIndex = result.findLastIndex(msg => msg.role === 'user')

    if (index > userIndex) {
      result[index] = { ...result[index]!, taskTiming: timing }
    }
  }

  return result
}
