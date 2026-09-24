// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-error";

const mocks = vi.hoisted(() => ({
  clients: [] as Array<{ emit: (event: unknown) => void; requests: Array<{ method: string; params: Record<string, unknown> }> }>,
  getSessions: vi.fn(async () => ({ sessions: [] })),
  getSessionMessages: vi.fn(async (): Promise<{ messages: Array<{
    role: string; content?: string; timestamp?: number;
  }> }> => { throw new Error("未保存"); }),
  snapshotRequest: null as Promise<Record<string, unknown>> | null,
  activeSessions: [] as Array<{ id: string; session_key: string; title: string; model: string; status: string; last_active: number }>,
}));

vi.mock("@hermes/shared", () => ({
  JsonRpcGatewayClient: class {
    connectionState = "idle";
    requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    private eventHandlers = new Set<(event: unknown) => void>();
    private stateHandlers = new Set<(state: string) => void>();
    constructor() { mocks.clients.push(this); }
    async connect() { this.connectionState = "open"; this.stateHandlers.forEach((handler) => handler("open")); }
    close() { this.connectionState = "closed"; }
    onAny(handler: (event: unknown) => void) { this.eventHandlers.add(handler); return () => this.eventHandlers.delete(handler); }
    onState(handler: (state: string) => void) { this.stateHandlers.add(handler); handler(this.connectionState); return () => this.stateHandlers.delete(handler); }
    onRequest() { return () => {}; }
    emit(event: unknown) { this.eventHandlers.forEach((handler) => handler(event)); }
    disconnect() { this.connectionState = "closed"; this.stateHandlers.forEach((handler) => handler("closed")); }
    async request(method: string, params: Record<string, unknown>) {
      this.requests.push({ method, params });
      if (method === "session.active_list") return { sessions: mocks.activeSessions };
      if (method === "session.create") {
        const count = this.requests.filter((item) => item.method === "session.create").length;
        return { session_id: `run-${count}`, stored_session_id: `stored-${count}`, messages: [], info: { model: "test-model" } };
      }
      if (method === "session.activate") return mocks.snapshotRequest ?? { session_id: params.session_id, messages: [], info: { model: "test-model" } };
      if (method === "session.resume") {
        if (params.session_id === "missing") throw new Error("会话不存在");
        return mocks.snapshotRequest ?? { session_id: "run-restored", messages: [], info: { model: "test-model" } };
      }
      if (method === "session.title") return { title: params.title };
      if (method === "session.close") {
        mocks.activeSessions = mocks.activeSessions.filter((row) => row.id !== params.session_id);
        return { closed: true };
      }
      if (method === "session.delete") return { deleted: params.session_id };
      if (method === "prompt.submit" && params.text === "失败消息") throw new Error("发送失败");
      return {};
    }
  },
}));
vi.mock("@/contexts/useProfileScope", () => ({ useProfileScope: () => ({ profile: "" }) }));
vi.mock("@/lib/api", () => ({
  api: { getSessions: mocks.getSessions, getSessionMessages: mocks.getSessionMessages },
  buildWsUrl: async () => "ws://localhost/api/ws",
}));
vi.mock("@/components/Markdown", () => ({ Markdown: ({ content }: { content: string }) => <span>{content}</span> }));

import GraphicalChatPage from "./GraphicalChatPage";

let root: Root;
let host: HTMLDivElement;
let stored: Record<string, string> = {};
const storage = {
  getItem: (key: string) => stored[key] ?? null,
  setItem: (key: string, value: string) => { stored[key] = value; },
  removeItem: (key: string) => { delete stored[key]; },
  clear: () => { stored = {}; },
};
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

function typeMessage(value: string) {
  const input = host.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(async () => {
  mocks.clients.length = 0;
  mocks.getSessionMessages.mockReset();
  mocks.getSessionMessages.mockRejectedValue(new Error("未保存"));
  mocks.snapshotRequest = null;
  mocks.activeSessions = [];
  vi.stubGlobal("localStorage", storage);
  storage.clear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: () => {}, configurable: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<MemoryRouter><GraphicalChatPage /></MemoryRouter>));
  await flush();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

describe("图形聊天页面", () => {
  it("新会话提交不会关闭后台会话，流式消息分别显示", async () => {
    const client = mocks.clients[0];
    await act(async () => { typeMessage("任务甲"); });
    await act(async () => { (host.querySelector('button[aria-label="发送"]') as HTMLButtonElement).click(); });
    await flush();
    expect(client.requests.filter((item) => item.method === "prompt.submit")[0].params.session_id).toBe("run-1");

    await act(async () => {
      const button = [...host.querySelectorAll<HTMLButtonElement>("aside button")].find((item) => item.textContent?.includes("新对话"));
      button?.click();
    });
    await act(async () => { typeMessage("任务乙"); });
    await act(async () => { (host.querySelector('button[aria-label="发送"]') as HTMLButtonElement).click(); });
    await flush();
    expect(client.requests.filter((item) => item.method === "prompt.submit")[1].params.session_id).toBe("run-2");
    expect(client.requests.some((item) => item.method === "session.close")).toBe(false);

    await act(async () => {
      client.emit({ type: "message.delta", session_id: "run-1", payload: { text: "甲的回复" } });
      client.emit({ type: "message.delta", session_id: "run-2", payload: { text: "乙的回复" } });
    });
    expect(host.textContent).toContain("乙的回复");
    expect(host.textContent).not.toContain("甲的回复");

    await act(async () => { (host.querySelector('nav[aria-label="对话列表"] button:first-child') as HTMLButtonElement).click(); });
    expect(host.textContent).toContain("甲的回复");
  });

  it("断线后恢复选中会话并继续接收其消息", async () => {
    const client = mocks.clients[0] as typeof mocks.clients[number] & { disconnect: () => void };
    await act(async () => { typeMessage("继续任务"); });
    await act(async () => { (host.querySelector('button[aria-label="发送"]') as HTMLButtonElement).click(); });
    await flush();

    vi.useFakeTimers();
    try {
      await act(async () => { client.disconnect(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(client.requests.some((item) => item.method === "session.resume" && item.params.session_id === "stored-1")).toBe(true);
      await act(async () => { client.emit({ type: "message.delta", session_id: "run-restored", payload: { text: "恢复后的回复" } }); });
      expect(host.textContent).toContain("恢复后的回复");
    } finally {
      vi.useRealTimers();
    }
  });

  it("刷新后已消失的临时会话会回到新对话", async () => {
    await act(async () => root.unmount());
    storage.setItem("hermes.chat-ui.selected.", "missing");
    mocks.getSessionMessages.mockRejectedValue(new ApiError("不存在", {
      status: 404, body: "不存在", url: "/api/sessions/missing/messages",
    }));
    root = createRoot(host);
    await act(async () => root.render(<MemoryRouter><GraphicalChatPage /></MemoryRouter>));
    await flush();
    expect(storage.getItem("hermes.chat-ui.selected.")).toBeNull();
    expect(host.textContent).toContain("开始与 Hermes 对话");
  });

  it("发送失败时保留草稿并撤回未送达的消息", async () => {
    await act(async () => { typeMessage("失败消息"); });
    await act(async () => { (host.querySelector('button[aria-label="发送"]') as HTMLButtonElement).click(); });
    await flush();
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("失败消息");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("发送失败");
    expect(host.querySelectorAll("main .whitespace-pre-wrap")).toHaveLength(0);
  });

  it("运行时显示本次任务计时，完成后在回复和标题栏保留耗时", async () => {
    const client = mocks.clients[0];
    await act(async () => { typeMessage("计时任务"); });
    await act(async () => { (host.querySelector('button[aria-label="发送"]') as HTMLButtonElement).click(); });
    const start = Math.floor(Date.now() / 1000) - 65;
    await act(async () => { client.emit({
      type: "message.start", session_id: "run-1",
      payload: { task_timing: { started_at: start, finished_at: null, status: "running", approximate: false } },
    }); });
    expect(host.querySelector("main header")?.textContent).toContain("本次任务：1分");

    await act(async () => { client.emit({
      type: "message.complete", session_id: "run-1",
      payload: { text: "计时结果", task_timing: {
        started_at: start, finished_at: start + 95, status: "complete", approximate: false,
      } },
    }); });
    expect(host.textContent?.match(/任务耗时：1分35秒/g)).toHaveLength(2);
  });

  it("重新打开旧会话时从真实消息时间恢复估算耗时", async () => {
    await act(async () => root.unmount());
    storage.setItem("hermes.chat-ui.selected.", "saved");
    mocks.getSessionMessages.mockResolvedValue({ messages: [
      { role: "user", content: "旧需求", timestamp: 1000 },
      { role: "assistant", content: "旧回复", timestamp: 1120 },
    ] });
    root = createRoot(host);
    await act(async () => root.render(<MemoryRouter><GraphicalChatPage /></MemoryRouter>));
    await flush();
    expect(host.textContent?.match(/任务耗时：约 2分0秒/g)).toHaveLength(2);
  });

  it("历史估算先到时仍采用网关的精确运行计时", async () => {
    await act(async () => root.unmount());
    storage.setItem("hermes.chat-ui.selected.", "saved");
    const startedAt = Math.floor(Date.now() / 1000) - 120;
    mocks.getSessionMessages.mockResolvedValue({ messages: [
      { role: "user", content: "正在执行的需求", timestamp: startedAt + 2 },
      { role: "assistant", content: "阶段性进展", timestamp: startedAt + 30 },
    ] });
    let resolveSnapshot!: (value: Record<string, unknown>) => void;
    mocks.snapshotRequest = new Promise((resolve) => { resolveSnapshot = resolve; });
    root = createRoot(host);
    await act(async () => root.render(<MemoryRouter><GraphicalChatPage /></MemoryRouter>));
    await flush();
    expect(host.querySelector("main header")?.textContent).toContain("任务耗时：约 28秒");

    await act(async () => resolveSnapshot({
      session_id: "run-restored", running: true, messages: [],
      info: { model: "test-model", task_timing: {
        started_at: startedAt, finished_at: null, status: "running", approximate: false,
      } },
    }));
    await flush();
    expect(host.querySelector("main header")?.textContent).toContain("本次任务：2分");
    expect(host.querySelector("main header")?.textContent).not.toContain("约");
  });

  it("右键可重命名运行中的会话，但不提供运行中删除", async () => {
    const client = mocks.clients[0];
    await act(async () => { typeMessage("原任务"); });
    await act(async () => { (host.querySelector('button[aria-label="发送"]') as HTMLButtonElement).click(); });
    await act(async () => {
      host.querySelector('[data-session-row="stored-1"]')?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, clientX: 100, clientY: 120,
      }));
    });
    expect(host.querySelector('[role="menuitem"][data-action="delete"]')).toHaveProperty("disabled", true);
    await act(async () => { (host.querySelector('[role="menuitem"][data-action="rename"]') as HTMLButtonElement).click(); });
    const input = host.querySelector('input[aria-label="会话名称"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "新的会话名");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { (host.querySelector('button[aria-label="保存会话名称"]') as HTMLButtonElement).click(); });
    expect(client.requests).toContainEqual({ method: "session.title", params: {
      session_id: "run-1", profile: "", title: "新的会话名",
    } });
    expect(host.querySelector('[data-session-row="stored-1"]')?.textContent).toContain("新的会话名");
    expect(client.requests.some((item) => item.method === "session.delete")).toBe(false);
    await act(async () => { (host.querySelector('button[aria-label="更多操作：新的会话名"]') as HTMLButtonElement).click(); });
    expect(host.querySelector('[role="menu"][aria-label="会话操作：新的会话名"]')).not.toBeNull();
  });

  it("空闲会话确认后先关闭运行实例再删除，选中状态随之清除", async () => {
    const client = mocks.clients[0];
    await act(async () => { typeMessage("待删除任务"); });
    await act(async () => { (host.querySelector('button[aria-label="发送"]') as HTMLButtonElement).click(); });
    mocks.activeSessions = [{
      id: "run-1", session_key: "stored-1", title: "待删除任务", model: "test-model",
      status: "idle", last_active: Date.now() / 1000,
    }];
    await act(async () => { client.emit({ type: "message.complete", session_id: "run-1", payload: { text: "完成" } }); });
    await flush();
    await act(async () => {
      host.querySelector('[data-session-row="stored-1"]')?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, clientX: 100, clientY: 120,
      }));
    });
    await act(async () => { (host.querySelector('[role="menuitem"][data-action="delete"]') as HTMLButtonElement).click(); });
    expect(client.requests.some((item) => item.method === "session.delete")).toBe(false);
    await act(async () => { (host.querySelector('button[aria-label="确认删除会话"]') as HTMLButtonElement).click(); });
    const actions = client.requests.map((item) => item.method);
    expect(actions.indexOf("session.close")).toBeGreaterThan(-1);
    expect(actions.indexOf("session.delete")).toBeGreaterThan(actions.indexOf("session.close"));
    expect(host.querySelector('[data-session-row="stored-1"]')).toBeNull();
    expect(storage.getItem("hermes.chat-ui.selected.")).toBeNull();
  });
});
