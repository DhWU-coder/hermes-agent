import { PassThrough } from 'node:stream'

import { Box, renderSync } from '@hermes/ink'
import { stripAnsi } from '@hermes/shared/ansi'
import type { TaskTiming } from '@hermes/shared/gateway-events'
import { afterEach, expect, it } from 'vitest'

import { $taskTiming, applyTaskTiming, restoreTaskTiming } from '../app/taskTimingStore.js'
import { StatusRule } from '../components/appChrome.js'
import { MessageLine } from '../components/messageLine.js'
import { TaskTimingLine } from '../components/taskTiming.js'
import { toTranscriptMessages } from '../domain/messages.js'
import { taskTimingLabel } from '../lib/taskTiming.js'
import { estimatedMsgHeight, messageHeightKey } from '../lib/virtualHeights.js'
import { DEFAULT_THEME } from '../theme.js'
import type { Msg } from '../types.js'

afterEach(() => $taskTiming.set(null))

it('keeps one task across background resumes, freezes its footer, and restores each session independently', () => {
  const started = 1_800_000_000
  const waiting: TaskTiming = { started_at: started, finished_at: null, status: 'waiting', approximate: false }
  const done: TaskTiming = { ...waiting, finished_at: started + 4266, status: 'complete' }

  const messages: Msg[] = [
    { role: 'user', text: '生成课件' },
    { role: 'assistant', text: '后台排版中' }
  ]

  expect(applyTaskTiming(messages, waiting).some(msg => msg.taskTiming)).toBe(false)
  expect(taskTimingLabel(waiting, started + 60)).toContain('1分0秒（后台处理中）')
  const final = applyTaskTiming([...messages, { role: 'assistant', text: '课件已完成' }], done)
  expect(final.filter(msg => msg.taskTiming)).toHaveLength(1)
  expect(final.at(-1)?.taskTiming).toEqual(done)
  expect(taskTimingLabel(done, started + 20000)).toBe(taskTimingLabel(done, started + 5000))
  const restored = toTranscriptMessages([{ role: 'assistant', text: '课件已完成', task_timing: done }])
  restoreTaskTiming(restored)
  expect($taskTiming.get()).toEqual(done)
  restoreTaskTiming([])
  expect($taskTiming.get()).toBeNull()
  restoreTaskTiming(restored)
  expect(taskTimingLabel($taskTiming.get()!)).toContain('1小时11分6秒')
  const options = { compact: true, details: false }
  expect(estimatedMsgHeight(final.at(-1)!, 80, options)).toBeGreaterThan(
    estimatedMsgHeight({ role: 'assistant', text: '课件已完成' }, 80, options)
  )
  expect(messageHeightKey(final.at(-1)!)).not.toBe(messageHeightKey({ role: 'assistant', text: '课件已完成' }))
})

it('renders the task duration and reply footer on a narrow terminal despite a long session title', () => {
  const timing: TaskTiming = { started_at: 1000, finished_at: 5266, status: 'complete', approximate: true }
  $taskTiming.set(timing)
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const stderr = new PassThrough()
  Object.assign(stdout, { columns: 60, rows: 25, isTTY: false })
  Object.assign(stdin, { isTTY: false })
  let output = ''
  stdout.on('data', chunk => {
    output += String(chunk)
  })

  const instance = renderSync(
    <Box flexDirection="column" width={60}>
      <MessageLine
        cols={60}
        compact
        msg={{ role: 'assistant', text: '课件已完成', taskTiming: timing }}
        t={DEFAULT_THEME}
      />
      <TaskTimingLine t={DEFAULT_THEME} />
      <StatusRule
        bgCount={0}
        busy={false}
        cols={60}
        cwdLabel=""
        liveSessionCount={0}
        model="test-model"
        sessionTitle={'非常长的会话标题'.repeat(25)}
        status="ready"
        statusColor={DEFAULT_THEME.color.ok}
        t={DEFAULT_THEME}
        usage={{ total: 0 }}
        voiceLabel=""
      />
    </Box>,
    {
      stdout: stdout as NodeJS.WriteStream,
      stdin: stdin as NodeJS.ReadStream,
      stderr: stderr as NodeJS.WriteStream,
      patchConsole: false
    }
  )

  try {
    const rendered = stripAnsi(output)
    expect(rendered).toContain('课件已完成')
    expect(rendered.match(/任务耗时：约 1小时11分6秒/g)).toHaveLength(2)
  } finally {
    instance.unmount()
    instance.cleanup()
  }
})
