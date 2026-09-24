import { Box, Text } from '@hermes/ink'
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { $taskTiming } from '../app/taskTimingStore.js'
import { taskTimingLabel } from '../lib/taskTiming.js'
import type { Theme } from '../theme.js'

export function TaskTimingLine({ t }: { t: Theme }) {
  const timing = useStore($taskTiming)
  const [now, setNow] = useState(() => Date.now() / 1000)

  useEffect(() => {
    // 完成后的时间保持冻结，只有运行及后台等待需要刷新。
    if (!timing || timing.finished_at != null) {
      return
    }

    setNow(Date.now() / 1000)
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000)

    return () => clearInterval(timer)
  }, [timing])

  return timing ? (
    <Box>
      <Text color={t.color.muted}>{taskTimingLabel(timing, Math.max(now, timing.started_at))}</Text>
    </Box>
  ) : null
}
