import type { GatewayEvent, TaskTiming } from "@hermes/shared";

export interface GraphicalMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  timestamp?: number;
  taskTiming?: TaskTiming;
  displayKind?: string;
}

export interface GraphicalSession {
  id: string;
  runtimeId?: string;
  title: string;
  model: string;
  messages: GraphicalMessage[];
  streaming: string;
  running: boolean;
  activity: string;
  error: string;
  taskTiming: TaskTiming | null;
}

export type GraphicalSessions = Record<string, GraphicalSession>;

export function emptyGraphicalSession(id: string, title = "新对话"): GraphicalSession {
  return { id, title, model: "", messages: [], streaming: "", running: false, activity: "", error: "", taskTiming: null };
}

function validTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function readGraphicalTaskTiming(value: unknown): TaskTiming | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const startedAt = validTimestamp(raw.started_at);
  const finishedAt = raw.finished_at == null ? null : validTimestamp(raw.finished_at);
  if (startedAt === null || (raw.finished_at != null && finishedAt === null) || (finishedAt !== null && finishedAt < startedAt)) return null;
  return {
    started_at: startedAt,
    finished_at: finishedAt,
    status: typeof raw.status === "string" ? raw.status : finishedAt === null ? "running" : "complete",
    approximate: raw.approximate === true,
  };
}

export function graphicalTaskTimingLabel(timing: TaskTiming, now = Date.now() / 1000): string {
  const end = timing.finished_at ?? now;
  if (!Number.isFinite(end) || end < timing.started_at) return "任务耗时：记录不完整";
  const seconds = Math.round(end - timing.started_at);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const duration = `${hours ? `${hours}小时` : ""}${minutes || hours ? `${minutes}分` : ""}${remainder}秒`;
  const suffix = ({ waiting: "（后台处理中）", error: "（失败）", interrupted: "（已中断）" } as Record<string, string>)[timing.status] ?? "";
  return `${timing.finished_at == null ? "本次任务" : "任务耗时"}：${timing.approximate ? "约 " : ""}${duration}${suffix}`;
}

export function latestGraphicalTaskTiming(messages: GraphicalMessage[]): TaskTiming | null {
  return [...messages].reverse().find((message) => message.taskTiming)?.taskTiming ?? null;
}

export function preferGraphicalTaskTiming(current: TaskTiming | null, candidate: TaskTiming | null): TaskTiming | null {
  if (!current || !candidate) return candidate ?? current;
  if (current.finished_at != null && candidate.started_at > current.finished_at) return candidate;
  if (candidate.finished_at != null && current.started_at > candidate.finished_at) return current;
  // 同一任务的消息时间戳可能晚于网关计时起点，不能用起点先后覆盖精确记录。
  if (current.approximate !== candidate.approximate) return candidate.approximate ? current : candidate;
  if (current.started_at !== candidate.started_at) return candidate.started_at > current.started_at ? candidate : current;
  return candidate.finished_at != null || current.finished_at == null ? candidate : current;
}

function isTaskPromptText(text: string, displayKind?: string): boolean {
  const trimmed = text.trimStart();
  return displayKind !== "steer" && !trimmed.startsWith("[ASYNC DELEGATION")
    && !trimmed.startsWith("[System note: Your previous turn was interrupted mid-run");
}

export function runningGraphicalTaskTiming(messages: GraphicalMessage[], startedAt?: number | null): TaskTiming | null {
  const start = validTimestamp(startedAt) ?? [...messages].reverse().find((message) =>
    message.role === "user" && isTaskPromptText(message.text, message.displayKind) && validTimestamp(message.timestamp))?.timestamp;
  return start ? { started_at: start, finished_at: null, status: "running", approximate: true } : null;
}

function attachFinalTiming(messages: GraphicalMessage[], timing: TaskTiming): GraphicalMessage[] {
  const replyIndex = messages.findLastIndex((message) => message.role === "assistant");
  const userIndex = messages.findLastIndex((message) => message.role === "user");
  if (replyIndex <= userIndex) return messages;
  return messages.map((message, index) => index === replyIndex ? { ...message, taskTiming: timing } : message);
}

export function projectGraphicalMessages(
  rows: Array<{
    role: string; text?: string | null; content?: string | null; timestamp?: number | null;
    name?: string | null; tool_name?: string | null; task_timing?: unknown;
    display_metadata?: Record<string, unknown> | null; display_kind?: string | null;
  }>,
): GraphicalMessage[] {
  const messages: GraphicalMessage[] = [];
  let taskStart: number | null = null;
  let lastReplyIndex = -1;
  for (const [index, row] of rows.entries()) {
    if (row.role !== "user" && row.role !== "assistant" && row.role !== "tool") continue;
    const text = row.text ?? row.content ?? "";
    // 后台唤醒和纠偏沿用原任务起点，不把它们当成新需求。
    if (row.role === "user" && isTaskPromptText(text, row.display_kind ?? undefined)) {
      taskStart = validTimestamp(row.timestamp);
      lastReplyIndex = -1;
    }
    if (!text) continue;
    const message: GraphicalMessage = {
      id: `stored-${index}-${row.timestamp ?? 0}`,
      role: row.role,
      text: row.role === "tool" ? `${row.name ?? row.tool_name ?? "工具"}\n${text}` : text,
      timestamp: row.timestamp ?? undefined,
      displayKind: row.display_kind ?? undefined,
    };
    if (row.role === "assistant") {
      const explicit = readGraphicalTaskTiming(row.task_timing ?? row.display_metadata?.task_timing);
      const finishedAt = validTimestamp(row.timestamp);
      const timing = explicit ?? (taskStart !== null && finishedAt !== null && finishedAt >= taskStart
        ? { started_at: taskStart, finished_at: finishedAt, status: "complete", approximate: true } : null);
      if (timing?.finished_at != null) {
        if (lastReplyIndex >= 0) delete messages[lastReplyIndex].taskTiming;
        message.taskTiming = timing;
        lastReplyIndex = messages.length;
      }
    }
    messages.push(message);
  }
  return messages;
}

export function applyGraphicalEvent(
  sessions: GraphicalSessions,
  runtimeToStored: ReadonlyMap<string, string>,
  event: GatewayEvent,
): GraphicalSessions {
  const storedId = event.session_id && runtimeToStored.get(event.session_id);
  if (!storedId) return sessions;
  const current = sessions[storedId] ?? emptyGraphicalSession(storedId);
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const eventTiming = readGraphicalTaskTiming(payload.task_timing);
  let next = current;

  if (event.type === "message.start") {
    const activeTiming = current.taskTiming?.finished_at == null ? current.taskTiming : null;
    next = {
      ...current, running: true, activity: "正在回复", error: "",
      taskTiming: eventTiming ?? activeTiming ?? runningGraphicalTaskTiming(current.messages, Date.now() / 1000),
    };
  } else if (event.type === "message.delta") {
    next = { ...current, running: true, streaming: current.streaming + String(payload.text ?? ""), activity: "正在回复" };
  } else if (event.type === "message.complete") {
    const text = typeof payload.text === "string" ? payload.text : current.streaming;
    const last = current.messages.at(-1);
    const messages = text && !(last?.role === "assistant" && last.text === text)
      ? [...current.messages, { id: `reply-${event.seq ?? Date.now()}`, role: "assistant" as const, text }]
      : current.messages;
    const priorTiming = current.taskTiming?.finished_at == null && current.taskTiming
      ? current.taskTiming : runningGraphicalTaskTiming(current.messages);
    const timing = eventTiming ?? (priorTiming ? {
      ...priorTiming, finished_at: Date.now() / 1000,
      status: payload.status === "error" || payload.status === "interrupted" ? String(payload.status) : "complete",
      approximate: true,
    } : null);
    next = {
      ...current,
      messages: timing?.finished_at != null ? attachFinalTiming(messages, timing) : messages,
      streaming: "",
      running: false,
      activity: "",
      error: payload.status === "error" ? String(payload.error ?? "任务执行失败") : "",
      taskTiming: timing,
    };
  } else if (event.type === "tool.start") {
    next = { ...current, running: true, activity: String(payload.name ?? "正在调用工具") };
  } else if (event.type === "tool.complete") {
    next = { ...current, activity: current.running ? "正在处理" : "" };
  } else if (event.type === "session.info") {
    next = {
      ...current,
      title: typeof payload.title === "string" && payload.title ? payload.title : current.title,
      model: typeof payload.model === "string" ? payload.model : current.model,
      taskTiming: eventTiming ?? current.taskTiming,
    };
  } else if (event.type === "error") {
    const timing = current.taskTiming?.finished_at == null && current.taskTiming
      ? { ...current.taskTiming, finished_at: Date.now() / 1000, status: "error", approximate: true }
      : current.taskTiming;
    next = {
      ...current, running: false, activity: "", error: String(payload.message ?? "会话发生错误"),
      taskTiming: timing, messages: timing?.finished_at != null ? attachFinalTiming(current.messages, timing) : current.messages,
    };
  }

  return next === current ? sessions : { ...sessions, [storedId]: next };
}
