import { describe, expect, it } from "vitest";

import {
  applyGraphicalEvent, emptyGraphicalSession, graphicalTaskTimingLabel,
  preferGraphicalTaskTiming, projectGraphicalMessages, readGraphicalTaskTiming,
} from "./graphicalChatState";

describe("图形聊天会话状态", () => {
  it("同时运行的两个会话按运行时 ID 隔离流式回复", () => {
    const ids = new Map([["run-a", "stored-a"], ["run-b", "stored-b"]]);
    const initial = {
      "stored-a": emptyGraphicalSession("stored-a"),
      "stored-b": emptyGraphicalSession("stored-b"),
    };
    const timedA = applyGraphicalEvent(initial, ids, {
      type: "message.start", session_id: "run-a",
      payload: { task_timing: { started_at: 1000, finished_at: null, status: "running" } },
    });
    const timedB = applyGraphicalEvent(timedA, ids, {
      type: "message.start", session_id: "run-b",
      payload: { task_timing: { started_at: 2000, finished_at: null, status: "running" } },
    });
    const first = applyGraphicalEvent(timedB, ids, {
      type: "message.delta", session_id: "run-a", payload: { text: "甲" },
    });
    const second = applyGraphicalEvent(first, ids, {
      type: "message.delta", session_id: "run-b", payload: { text: "乙" },
    });
    const done = applyGraphicalEvent(second, ids, {
      type: "message.complete", session_id: "run-a", payload: { text: "甲完成", status: "complete" },
    });

    expect(done["stored-a"].messages.at(-1)?.text).toBe("甲完成");
    expect(done["stored-a"].running).toBe(false);
    expect(done["stored-b"].streaming).toBe("乙");
    expect(done["stored-b"].running).toBe(true);
    expect(done["stored-a"].taskTiming?.started_at).toBe(1000);
    expect(done["stored-b"].taskTiming?.started_at).toBe(2000);
  });

  it("忽略未绑定会话的事件并投影真实的对话行", () => {
    const initial = { known: emptyGraphicalSession("known") };
    expect(applyGraphicalEvent(initial, new Map(), {
      type: "message.delta", session_id: "other", payload: { text: "无关" },
    })).toBe(initial);
    expect(projectGraphicalMessages([
      { role: "system", text: "隐藏" },
      { role: "user", content: "提问" },
      { role: "assistant", text: "回答" },
    ]).map((row) => row.text)).toEqual(["提问", "回答"]);
  });

  it("后台等待持续计时，完成事件只在最后回复留下冻结耗时", () => {
    const ids = new Map([["run", "stored"]]);
    const started = { started_at: 1_800_000_000, finished_at: null, status: "running", approximate: false };
    const waiting = { ...started, status: "waiting" };
    const finished = { ...started, finished_at: started.started_at + 4266, status: "complete" };
    const initial = { stored: { ...emptyGraphicalSession("stored"), messages: [
      { id: "user", role: "user" as const, text: "生成课件" },
    ] } };
    const running = applyGraphicalEvent(initial, ids, {
      type: "message.start", session_id: "run", payload: { task_timing: started },
    });
    const pending = applyGraphicalEvent(running, ids, {
      type: "message.complete", session_id: "run", payload: { text: "正在后台排版", task_timing: waiting },
    });
    expect(pending.stored.taskTiming).toEqual(waiting);
    expect(pending.stored.messages.at(-1)?.taskTiming).toBeUndefined();
    expect(graphicalTaskTimingLabel(waiting, started.started_at + 60)).toBe("本次任务：1分0秒（后台处理中）");

    const done = applyGraphicalEvent(pending, ids, {
      type: "message.complete", session_id: "run", payload: { text: "课件已完成", task_timing: finished },
    });
    expect(done.stored.messages.at(-1)?.taskTiming).toEqual(finished);
    expect(graphicalTaskTimingLabel(finished, started.started_at + 20000)).toBe("任务耗时：1小时11分6秒");
  });

  it("旧历史按消息时间估算，同一任务只在最后回复显示，缺失时间不猜测", () => {
    const rows = projectGraphicalMessages([
      { role: "user", text: "第一件事", timestamp: 1000 },
      { role: "assistant", text: "处理中", timestamp: 1010 },
      { role: "tool", text: "工具完成", timestamp: 1020 },
      { role: "assistant", text: "完成", timestamp: 1030 },
      { role: "user", text: "第二件事", timestamp: 2000 },
      { role: "assistant", text: "也完成", timestamp: 2050, display_metadata: {
        task_timing: { started_at: 1990, finished_at: 2050, status: "complete", approximate: false },
      } },
      { role: "user", text: "无时间记录" },
      { role: "assistant", text: "无法估算" },
    ]);
    expect(rows[1].taskTiming).toBeUndefined();
    expect(graphicalTaskTimingLabel(rows[3].taskTiming!)).toBe("任务耗时：约 30秒");
    expect(graphicalTaskTimingLabel(rows[5].taskTiming!)).toBe("任务耗时：1分0秒");
    expect(rows[7].taskTiming).toBeUndefined();
    expect(readGraphicalTaskTiming({ started_at: 100, finished_at: 99 })).toBeNull();
  });

  it("后台唤醒不重置原任务的估算起点", () => {
    const rows = projectGraphicalMessages([
      { role: "user", text: "生成报告", timestamp: 1000 },
      { role: "assistant", text: "正在后台处理", timestamp: 1010 },
      { role: "user", text: "[ASYNC DELEGATION 完成通知]", timestamp: 1020 },
      { role: "assistant", text: "报告已完成", timestamp: 1030 },
    ]);
    expect(rows[1].taskTiming).toBeUndefined();
    expect(graphicalTaskTimingLabel(rows[3].taskTiming!)).toBe("任务耗时：约 30秒");
  });

  it("精确记录不会被同一任务的消息时间戳覆盖，新任务仍能更新耗时", () => {
    const exact = { started_at: 1000, finished_at: 1100, status: "complete", approximate: false };
    const sameTaskEstimate = { started_at: 1002, finished_at: 1100, status: "complete", approximate: true };
    const nextTaskEstimate = { started_at: 1200, finished_at: 1250, status: "complete", approximate: true };
    expect(preferGraphicalTaskTiming(exact, sameTaskEstimate)).toEqual(exact);
    expect(preferGraphicalTaskTiming(exact, nextTaskEstimate)).toEqual(nextTaskEstimate);
  });
});
