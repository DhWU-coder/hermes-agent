import { JsonRpcGatewayClient, JsonRpcGatewayError, type ServerRequest, type TaskTiming } from "@hermes/shared";
import {
  Menu, MessageSquarePlus, MoreHorizontal, Paperclip, Pencil, RefreshCw, Send, Square, Trash2, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";

import { Markdown } from "@/components/Markdown";
import { useProfileScope } from "@/contexts/useProfileScope";
import { api, buildWsUrl, type SessionInfo } from "@/lib/api";
import { ApiError } from "@/lib/api-error";
import { fileReference, uploadChatFile } from "@/lib/chatFilePaste";
import { isDashboardEmbeddedChatEnabled } from "@/lib/dashboard-flags";
import {
  applyGraphicalEvent, emptyGraphicalSession, projectGraphicalMessages,
  graphicalTaskTimingLabel, latestGraphicalTaskTiming, preferGraphicalTaskTiming,
  readGraphicalTaskTiming, runningGraphicalTaskTiming,
  type GraphicalSessions,
} from "@/lib/graphicalChatState";
import { timeAgo } from "@/lib/utils";

interface Attachment {
  name: string;
  path: string;
}

interface LiveRow {
  id: string;
  session_key: string;
  title: string;
  model: string;
  status: string;
  last_active: number;
}

interface SessionActiveListResult { sessions: LiveRow[] }
interface SessionSnapshot {
  session_id: string;
  stored_session_id?: string;
  messages: Array<{
    role: string; text?: string | null; content?: string | null; timestamp?: number | null;
    name?: string | null; task_timing?: unknown; display_metadata?: Record<string, unknown> | null;
  }>;
  info?: { model?: string; title?: string; task_timing?: TaskTiming | null };
  running?: boolean;
  turn_started_at?: number | null;
  inflight?: { assistant?: string; streaming?: boolean };
}
interface SessionCreateResult extends SessionSnapshot { stored_session_id: string }
interface SessionActionMenu { id: string; x: number; y: number }
interface SessionActionDialog { id: string; title: string; kind: "rename" | "delete" }

const LIVE_STATUSES = new Set(["working", "streaming", "waiting", "starting", "resuming"]);
const PROMPT_METHODS = new Set([
  "approval", "clarify", "sudo", "secret", "vault.unlock_prompt", "vault.save_login", "vault.code",
]);
const APPROVAL_LABELS: Record<string, string> = {
  once: "仅本次允许", session: "本会话允许", always: "始终允许", deny: "拒绝",
};

function requestDescription(request: ServerRequest): string {
  const params = request.params;
  if (request.method === "approval") return String(params.description || params.command || "工具请求授权");
  if (request.method === "clarify") return String(params.question || "Hermes 需要你补充信息");
  if (request.method === "sudo") return `请输入 sudo 密码：${String(params.command || "")}`;
  if (request.method === "secret") return String(params.prompt || `请输入 ${String(params.env_var || "密钥")}`);
  if (request.method === "vault.unlock_prompt") return `解锁 ${String(params.display_name || "密码库")}`;
  if (request.method === "vault.save_login") return `是否保存 ${String(params.site || "此网站")} 的登录信息？`;
  if (request.method === "vault.code") return `请输入 ${String(params.site || "网站")} 的验证码`;
  return request.method;
}

function requestChoices(request: ServerRequest): string[] {
  const choices = request.params.choices;
  return Array.isArray(choices) ? choices.filter((item): item is string => typeof item === "string") : [];
}

function sessionTitle(session: SessionInfo): string {
  return session.title?.trim() || session.preview?.trim() || "未命名对话";
}

function displayError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseModelChoice(value: string): { model: string; provider?: string } {
  const match = value.trim().match(/^(.*?)\s+--provider\s+(\S+)$/);
  return match ? { model: match[1], provider: match[2] } : { model: value.trim() };
}

function GraphicalRequestCard({ request, onDone }: { request: ServerRequest; onDone: () => void }) {
  const [answer, setAnswer] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const questions = Array.isArray(request.params.questions) ? request.params.questions as Array<{
    qid: string; question: string; choices?: string[];
  }> : [];
  const send = (result: Record<string, unknown>) => {
    request.respond(result);
    onDone();
  };
  const valueMethod = request.method !== "approval" && request.method !== "clarify";
  const masked = ["sudo", "secret", "vault.unlock_prompt", "vault.save_login", "vault.code"].includes(request.method);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-background p-5 shadow-2xl">
        <div className="mb-2 text-sm font-semibold text-foreground">Hermes 需要你的回应</div>
        <p className="mb-4 whitespace-pre-wrap text-sm text-muted-foreground">{requestDescription(request)}</p>
        {request.method === "approval" ? (
          <div className="flex flex-wrap gap-2">
            {(requestChoices(request).length ? requestChoices(request) : ["once", "deny"]).map((choice) => (
              <button key={choice} className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted" onClick={() => send({ choice })}>
                {APPROVAL_LABELS[choice] || choice}
              </button>
            ))}
          </div>
        ) : request.method === "clarify" && questions.length ? (
          <form onSubmit={(event) => { event.preventDefault(); send({ answers }); }} className="space-y-3">
            {questions.map((question) => (
              <label key={question.qid} className="block text-sm">
                <span className="mb-1 block">{question.question}</span>
                {question.choices?.length ? (
                  <select className="w-full rounded-lg border border-border bg-background p-2" value={answers[question.qid] || ""} onChange={(event) => setAnswers((old) => ({ ...old, [question.qid]: event.target.value }))}>
                    <option value="">请选择</option>
                    {question.choices.map((choice) => <option key={choice}>{choice}</option>)}
                  </select>
                ) : (
                  <input className="w-full rounded-lg border border-border bg-background p-2" value={answers[question.qid] || ""} onChange={(event) => setAnswers((old) => ({ ...old, [question.qid]: event.target.value }))} />
                )}
              </label>
            ))}
            <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">提交回答</button>
          </form>
        ) : request.method === "vault.save_login" ? (
          <form onSubmit={(event) => { event.preventDefault(); send({ value: JSON.stringify({ identifier, password: answer }) }); }} className="space-y-3">
            <input className="w-full rounded-lg border border-border bg-background p-2 text-sm" placeholder="账号" value={identifier} onChange={(event) => setIdentifier(event.target.value)} />
            <input type="password" className="w-full rounded-lg border border-border bg-background p-2 text-sm" placeholder="密码" value={answer} onChange={(event) => setAnswer(event.target.value)} />
            <div className="flex gap-2"><button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">保存</button><button type="button" className="rounded-lg border border-border px-4 py-2 text-sm" onClick={() => send({ value: "" })}>跳过</button></div>
          </form>
        ) : (
          <form onSubmit={(event) => { event.preventDefault(); send(valueMethod ? { value: answer } : { answer }); }}>
            {requestChoices(request).length ? (
              <select className="mb-4 w-full rounded-lg border border-border bg-background p-2 text-sm" value={answer} onChange={(event) => setAnswer(event.target.value)}>
                <option value="">请选择或跳过</option>
                {requestChoices(request).map((choice) => <option key={choice}>{choice}</option>)}
              </select>
            ) : (
              <input autoFocus type={masked ? "password" : "text"} className="mb-4 w-full rounded-lg border border-border bg-background p-2 text-sm" value={answer} onChange={(event) => setAnswer(event.target.value)} />
            )}
            <div className="flex gap-2">
              <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">提交</button>
              <button type="button" className="rounded-lg border border-border px-4 py-2 text-sm" onClick={() => send(valueMethod ? { value: "" } : { answer: "" })}>跳过</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default function GraphicalChatPage() {
  const { profile } = useProfileScope();
  const scope = profile || "";
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem(`hermes.chat-ui.selected.${scope}`));
  const [views, setViews] = useState<GraphicalSessions>({});
  const [listed, setListed] = useState<SessionInfo[]>([]);
  const [live, setLive] = useState<SessionActiveListResult["sessions"]>([]);
  const [connection, setConnection] = useState("连接中");
  const [pageError, setPageError] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState<ServerRequest[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelDraft, setModelDraft] = useState("");
  const [newModel, setNewModel] = useState("");
  const [newProvider, setNewProvider] = useState("");
  const [modelNames, setModelNames] = useState<string[]>([]);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [clockNow, setClockNow] = useState(() => Date.now() / 1000);
  const [actionMenu, setActionMenu] = useState<SessionActionMenu | null>(null);
  const [actionDialog, setActionDialog] = useState<SessionActionDialog | null>(null);
  const [actionTitle, setActionTitle] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const clientRef = useRef<JsonRpcGatewayClient | null>(null);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const runtimeToStored = useRef(new Map<string, string>());
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const skipBindOnce = useRef<string | null>(null);
  const selectionGeneration = useRef(0);
  const selected = selectedId ? views[selectedId] : null;
  const draftKey = selectedId || "new";
  const draft = drafts[draftKey] || "";

  const select = useCallback((id: string | null, preserveFiles = false) => {
    setActionMenu(null);
    setClockNow(Date.now() / 1000);
    setSelectedId(id);
    if (id) localStorage.setItem(`hermes.chat-ui.selected.${scope}`, id);
    else localStorage.removeItem(`hermes.chat-ui.selected.${scope}`);
    if (!preserveFiles) setFiles([]);
    setSidebarOpen(false);
  }, [scope]);

  const showActionMenu = useCallback((id: string, x: number, y: number) => {
    setActionMenu({
      id,
      x: Math.max(8, Math.min(x, window.innerWidth - 184)),
      y: Math.max(8, Math.min(y, window.innerHeight - 152)),
    });
  }, []);

  useEffect(() => {
    if (!actionMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (!actionMenuRef.current?.contains(event.target as Node)) setActionMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActionMenu(null);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [actionMenu]);

  const loadLists = useCallback(async (client?: JsonRpcGatewayClient | null) => {
    const [stored, active] = await Promise.allSettled([
      api.getSessions(100, 0, { profile: scope, order: "recent" }),
      client?.connectionState === "open"
        ? client.request<SessionActiveListResult>("session.active_list", { profile: scope })
        : Promise.resolve({ sessions: [] }),
    ]);
    if (stored.status === "fulfilled") setListed(stored.value.sessions);
    if (active.status === "fulfilled") {
      setLive(active.value.sessions);
      for (const row of active.value.sessions) runtimeToStored.current.set(row.id, row.session_key);
      setViews((old) => {
        const next = { ...old };
        for (const row of active.value.sessions) {
          const prior = next[row.session_key] ?? emptyGraphicalSession(row.session_key, row.title || "新对话");
          next[row.session_key] = {
            ...prior,
            runtimeId: row.id,
            title: row.title || prior.title,
            model: row.model || prior.model,
            running: LIVE_STATUSES.has(row.status),
          };
        }
        return next;
      });
    }
  }, [scope]);

  useEffect(() => {
    setSelectedId(localStorage.getItem(`hermes.chat-ui.selected.${scope}`));
    setViews({});
    setListed([]);
    setLive([]);
    setPending([]);
    setNewModel("");
    setNewProvider("");
    setActionMenu(null);
    setActionDialog(null);
    runtimeToStored.current.clear();
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const client = new JsonRpcGatewayClient();
    clientRef.current = client;

    const schedule = () => {
      if (stopped || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, Math.min(1000 * 2 ** attempts++, 10_000));
    };
    const connect = async () => {
      try {
        setConnection("连接中");
        await client.connect(await buildWsUrl("/api/ws"));
        if (stopped) return;
        attempts = 0;
        await client.request("client.capabilities", { server_requests: true });
        setConnection("已连接");
        void loadLists(client);
      } catch (error) {
        if (stopped) return;
        setConnection("连接中断");
        setPageError(displayError(error));
        schedule();
      }
    };
    const offState = client.onState((state) => {
      if (stopped) return;
      if (state === "closed" || state === "error") {
        setConnection("连接中断");
        setPending([]);
        runtimeToStored.current.clear();
        setViews((old) => Object.fromEntries(Object.entries(old).map(([id, view]) => [id, {
          ...view, runtimeId: undefined,
        }])));
        schedule();
      }
    });
    const offEvents = client.onAny((event) => {
      if (stopped) return;
      if (event.type === "request.cancel") {
        const id = (event.payload as { id?: string } | undefined)?.id;
        if (id) setPending((old) => old.filter((item) => item.id !== id));
      }
      setViews((old) => applyGraphicalEvent(old, runtimeToStored.current, event));
      if (event.type === "message.complete" || event.type === "session.info") void loadLists(client);
    });
    const offRequests = client.onRequest((request) => {
      if (!PROMPT_METHODS.has(request.method)) return false;
      setPending((old) => old.some((item) => item.id === request.id) ? old : [...old, request]);
      return true;
    });
    void connect();
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      offState();
      offEvents();
      offRequests();
      client.close();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [loadLists, scope]);

  useEffect(() => {
    const timer = setInterval(() => void loadLists(clientRef.current), 5000);
    return () => clearInterval(timer);
  }, [loadLists]);

  useEffect(() => {
    void loadLists(clientRef.current);
  }, [loadLists, refreshNonce]);

  const bindSession = useCallback(async (id: string): Promise<string> => {
    const client = clientRef.current;
    if (!client || client.connectionState !== "open") throw new Error("Hermes 尚未连接");
    const runtimeId = [...runtimeToStored.current].find(([, stored]) => stored === id)?.[0];
    let result: SessionSnapshot;
    try {
      result = runtimeId
        ? await client.request<SessionSnapshot>("session.activate", { session_id: runtimeId, profile: scope })
        : await client.request<SessionSnapshot>("session.resume", { session_id: id, profile: scope, source: "tui" });
    } catch (error) {
      if (!runtimeId) throw error;
      runtimeToStored.current.delete(runtimeId);
      result = await client.request<SessionSnapshot>("session.resume", { session_id: id, profile: scope, source: "tui" });
    }
    runtimeToStored.current.set(result.session_id, id);
    const rows = projectGraphicalMessages(result.messages);
    const snapshotTiming = readGraphicalTaskTiming(result.info?.task_timing)
      ?? (result.running ? runningGraphicalTaskTiming(rows, result.turn_started_at) : latestGraphicalTaskTiming(rows));
    setViews((old) => {
      const prior = old[id] ?? emptyGraphicalSession(id);
      const priorTiming = prior.taskTiming;
      return { ...old, [id]: {
        ...prior,
        runtimeId: result.session_id,
        model: result.info?.model || prior.model,
        title: result.info?.title || prior.title,
        messages: rows.length && (!prior.running || rows.length >= prior.messages.length) ? rows : prior.messages,
        streaming: result.inflight?.assistant ?? (result.running === false ? "" : prior.streaming),
        running: result.running ?? Boolean(result.inflight?.streaming || prior.running),
        activity: result.running === false ? "" : prior.activity,
        taskTiming: preferGraphicalTaskTiming(priorTiming, snapshotTiming),
      } };
    });
    return result.session_id;
  }, [scope]);

  useEffect(() => {
    if (!selectedId) return;
    const generation = ++selectionGeneration.current;
    const history = api.getSessionMessages(selectedId, scope).then((result) => {
      if (generation !== selectionGeneration.current) return;
      const rows = projectGraphicalMessages(result.messages);
      const historyTiming = latestGraphicalTaskTiming(rows);
      setViews((old) => {
        const prior = old[selectedId] ?? emptyGraphicalSession(selectedId);
        return { ...old, [selectedId]: {
          ...prior,
          messages: prior.running && rows.length < prior.messages.length ? prior.messages : rows,
          taskTiming: prior.taskTiming?.finished_at == null && prior.taskTiming
            ? prior.taskTiming
            : preferGraphicalTaskTiming(prior.taskTiming, historyTiming),
        } };
      });
    });
    let binding: Promise<unknown> = Promise.resolve();
    if (skipBindOnce.current === selectedId) {
      skipBindOnce.current = null;
    } else if (connection === "已连接") {
      binding = bindSession(selectedId);
    }
    void Promise.allSettled([history, binding]).then(([stored, attached]) => {
      if (generation !== selectionGeneration.current) return;
      if (stored.status === "rejected" && stored.reason instanceof ApiError && stored.reason.status === 404 && attached.status === "rejected") {
        select(null);
        setPageError("");
      } else if (attached.status === "rejected") {
        setPageError(displayError(attached.reason));
      }
    });
    return () => { selectionGeneration.current += 1; };
  }, [bindSession, connection, scope, select, selectedId]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: "end" }); }, [selected?.messages.length, selected?.streaming, selectedId]);

  useEffect(() => {
    if (!selected?.taskTiming || selected.taskTiming.finished_at != null) return;
    const timer = setInterval(() => setClockNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, [selected?.taskTiming]);

  const createSession = useCallback(async (initialDraft: string): Promise<{ id: string; runtimeId: string }> => {
    const client = clientRef.current;
    if (!client || client.connectionState !== "open") throw new Error("Hermes 尚未连接");
    const result = await client.request<SessionCreateResult>("session.create", {
      profile: scope, source: "tui", ...(newModel ? { model: newModel } : {}),
      ...(newProvider ? { provider: newProvider } : {}),
    });
    const id = result.stored_session_id;
    skipBindOnce.current = id;
    runtimeToStored.current.set(result.session_id, id);
    setViews((old) => ({ ...old, [id]: {
      ...emptyGraphicalSession(id), runtimeId: result.session_id, model: result.info?.model || "",
    } }));
    setDrafts((old) => ({ ...old, new: "", [id]: initialDraft }));
    select(id, true);
    void loadLists(client);
    return { id, runtimeId: result.session_id };
  }, [loadLists, newModel, newProvider, scope, select]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text && files.length === 0) return;
    setPageError("");
    let targetId: string | null = null;
    let previousTiming: TaskTiming | null = null;
    const optimisticId = `user-${Date.now()}-${Math.random()}`;
    try {
      const target = selectedId
        ? { id: selectedId, runtimeId: views[selectedId]?.runtimeId || await bindSession(selectedId) }
        : await createSession(draft);
      targetId = target.id;
      previousTiming = views[target.id]?.taskTiming ?? null;
      const fullText = [text, ...files.map((file) => fileReference(file.path))].filter(Boolean).join("\n");
      const startedAt = Date.now() / 1000;
      setClockNow(startedAt);
      setViews((old) => {
        const prior = old[target.id] ?? emptyGraphicalSession(target.id);
        return { ...old, [target.id]: {
          ...prior, running: true, activity: "正在处理", error: "",
          taskTiming: runningGraphicalTaskTiming(prior.messages, startedAt),
          messages: [...prior.messages, { id: optimisticId, role: "user", text: fullText, timestamp: Date.now() / 1000 }],
        } };
      });
      await clientRef.current?.request("prompt.submit", { session_id: target.runtimeId, profile: scope, text: fullText, surface: "dashboard" });
      setDrafts((old) => ({ ...old, [draftKey]: "", [target.id]: "" }));
      setFiles([]);
      void loadLists(clientRef.current);
    } catch (error) {
      setPageError(displayError(error));
      const failedTargetId = targetId;
      if (failedTargetId) setViews((old) => {
        const prior = old[failedTargetId];
        return prior ? { ...old, [failedTargetId]: {
          ...prior, running: false, activity: "", error: displayError(error),
          taskTiming: previousTiming,
          messages: prior.messages.filter((message) => message.id !== optimisticId),
        } } : old;
      });
    }
  }, [bindSession, createSession, draft, draftKey, files, loadLists, scope, selectedId, views]);

  const stop = useCallback(async () => {
    if (!selected?.runtimeId) return;
    try {
      await clientRef.current?.request("session.interrupt", { session_id: selected.runtimeId, profile: scope });
    } catch (error) { setPageError(displayError(error)); }
  }, [scope, selected?.runtimeId]);

  const chooseModel = useCallback(async () => {
    if (!modelDraft.trim()) return;
    if (!selected) {
      const choice = parseModelChoice(modelDraft);
      setNewModel(choice.model);
      setNewProvider(choice.provider || "");
      setModelOpen(false);
      return;
    }
    if (!selected.runtimeId) return;
    try {
      const result = await clientRef.current?.request<{ value?: string; confirm_required?: boolean; confirm_message?: string }>("config.set", {
        key: "model", session_id: selected.runtimeId, profile: scope, value: modelDraft.trim(),
      });
      if (result?.confirm_required) {
        if (!window.confirm(result.confirm_message || "确认切换到此模型？")) return;
        await clientRef.current?.request("config.set", {
          key: "model", session_id: selected.runtimeId, profile: scope,
          value: modelDraft.trim(), confirm_expensive_model: true,
        });
      }
      setViews((old) => {
        const prior = old[selected.id];
        return prior ? { ...old, [selected.id]: { ...prior, model: result?.value || parseModelChoice(modelDraft).model } } : old;
      });
      setModelOpen(false);
    } catch (error) { setPageError(displayError(error)); }
  }, [modelDraft, scope, selected]);

  useEffect(() => {
    if (!modelOpen) return;
    let cancelled = false;
    api.getModelOptions(scope).then((result) => {
      if (cancelled) return;
      setModelNames([...new Set(result.providers.flatMap((provider) =>
        (provider.models || []).map((model) => `${model} --provider ${provider.slug}`),
      ))].sort());
    }).catch((error) => { if (!cancelled) setPageError(displayError(error)); });
    return () => { cancelled = true; };
  }, [modelOpen, scope]);

  const upload = useCallback(async (incoming: File[]) => {
    if (!incoming.length) return;
    setUploading(true);
    setPageError("");
    try {
      const uploaded = await Promise.all(incoming.map((file) => uploadChatFile(file, scope)));
      setFiles((old) => [...old, ...uploaded.map(({ name, path }) => ({ name, path }))]);
    } catch (error) { setPageError(displayError(error)); }
    finally { setUploading(false); }
  }, [scope]);

  const rows = useMemo(() => {
    const byId = new Map<string, { id: string; title: string; lastActive: number; running: boolean }>();
    for (const row of listed) byId.set(row.id, { id: row.id, title: sessionTitle(row), lastActive: row.last_active, running: false });
    for (const row of live) byId.set(row.session_key, {
      id: row.session_key, title: row.title || byId.get(row.session_key)?.title || "新对话",
      lastActive: row.last_active, running: LIVE_STATUSES.has(row.status),
    });
    for (const view of Object.values(views)) {
      const row = byId.get(view.id);
      if (!row) byId.set(view.id, { id: view.id, title: view.title, lastActive: Date.now() / 1000, running: view.running });
      else byId.set(view.id, { ...row, title: view.title !== "新对话" ? view.title : row.title, running: view.running || row.running });
    }
    return [...byId.values()].sort((a, b) => b.lastActive - a.lastActive);
  }, [listed, live, views]);

  const menuRow = actionMenu ? rows.find((row) => row.id === actionMenu.id) : null;
  const dialogRunning = actionDialog ? rows.some((row) => row.id === actionDialog.id && row.running) : false;

  const openActionDialog = (kind: SessionActionDialog["kind"]) => {
    if (!menuRow) return;
    setActionDialog({ id: menuRow.id, title: menuRow.title, kind });
    setActionTitle(menuRow.title === "新对话" ? "" : menuRow.title);
    setActionError("");
    setActionMenu(null);
  };

  const submitAction = async () => {
    if (!actionDialog || actionBusy) return;
    const { id, kind } = actionDialog;
    const title = actionTitle.trim();
    if (kind === "rename" && !title) {
      setActionError("请输入会话名称");
      return;
    }
    if (kind === "delete" && dialogRunning) {
      setActionError("会话正在运行，请先停止任务");
      return;
    }
    setActionBusy(true);
    setActionError("");
    try {
      const client = clientRef.current;
      if (kind === "rename") {
        const runtimeId = live.find((row) => row.session_key === id)?.id || views[id]?.runtimeId;
        let result: { title: string };
        if (runtimeId && client?.connectionState === "open") {
          try {
            result = await client.request<{ title: string }>("session.title", { session_id: runtimeId, profile: scope, title });
          } catch (error) {
            if (!(error instanceof JsonRpcGatewayError && error.code === 4001)) throw error;
            result = await api.renameSession(id, title, scope);
          }
        } else {
          result = await api.renameSession(id, title, scope);
        }
        const savedTitle = result.title || title;
        setListed((old) => old.map((row) => row.id === id ? { ...row, title: savedTitle } : row));
        setLive((old) => old.map((row) => row.session_key === id ? { ...row, title: savedTitle } : row));
        setViews((old) => old[id] ? { ...old, [id]: { ...old[id], title: savedTitle } } : old);
      } else {
        if (!client || client.connectionState !== "open") throw new Error("连接中断，暂时无法安全删除会话");
        const active = await client.request<SessionActiveListResult>("session.active_list", { profile: scope });
        const liveRow = active.sessions.find((row) => row.session_key === id);
        if (liveRow && LIVE_STATUSES.has(liveRow.status)) throw new Error("会话正在运行，请先停止任务");
        if (liveRow) await client.request("session.close", { session_id: liveRow.id, profile: scope });
        try {
          await client.request("session.delete", { session_id: id, profile: scope });
        } catch (error) {
          // 尚未发送过消息的草稿没有数据库记录，关闭运行实例后即完成删除。
          if (!(error instanceof JsonRpcGatewayError && error.code === 4007)) throw error;
        }
        for (const [runtimeId, storedId] of runtimeToStored.current) {
          if (storedId === id) runtimeToStored.current.delete(runtimeId);
        }
        setListed((old) => old.filter((row) => row.id !== id));
        setLive((old) => old.filter((row) => row.session_key !== id));
        setViews((old) => { const next = { ...old }; delete next[id]; return next; });
        setDrafts((old) => { const next = { ...old }; delete next[id]; return next; });
        if (selectedId === id) select(null);
      }
      setActionDialog(null);
      void loadLists(clientRef.current);
    } catch (error) {
      setActionError(displayError(error));
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-background text-foreground">
      <aside className={`${sidebarOpen ? "flex" : "hidden"} absolute inset-y-0 left-0 z-20 w-72 flex-col border-r border-border bg-card md:relative md:flex md:w-72`}>
        <div className="border-b border-border p-4">
          <div className="mb-4 flex items-center justify-between text-lg font-bold"><span>Hermes Chat</span><button className="md:hidden" onClick={() => setSidebarOpen(false)} aria-label="关闭会话列表"><X size={18} /></button></div>
          <button className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 font-medium text-primary-foreground" onClick={() => select(null)}><MessageSquarePlus size={17} />新对话</button>
        </div>
        <div className="flex items-center justify-between px-4 py-3 text-xs text-muted-foreground"><span>会话</span><button onClick={() => setRefreshNonce((n) => n + 1)} title="刷新会话"><RefreshCw size={15} /></button></div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="对话列表" onScroll={() => setActionMenu(null)}>
          {rows.map((row) => (
            <div key={row.id} data-session-row={row.id} onContextMenu={(event) => { event.preventDefault(); showActionMenu(row.id, event.clientX, event.clientY); }} className={`mb-1 flex items-center rounded-lg ${selectedId === row.id ? "bg-primary/15 text-primary" : "hover:bg-muted"}`}>
              <button onClick={() => select(row.id)} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm">
                <span className={`h-2 w-2 shrink-0 rounded-full ${row.running ? "bg-emerald-400" : "bg-muted-foreground/40"}`} />
                <span className="min-w-0 flex-1"><span className="block truncate font-medium">{row.title}</span><span className="block text-xs text-muted-foreground">{timeAgo(row.lastActive)}</span></span>
              </button>
              <button aria-label={`更多操作：${row.title}`} aria-haspopup="menu" aria-expanded={actionMenu?.id === row.id} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); showActionMenu(row.id, rect.right - 176, rect.bottom + 4); }} className="mr-1 shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><MoreHorizontal size={16} /></button>
            </div>
          ))}
        </nav>
        <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
          <div>{rows.filter((row) => row.running).length} 个会话正在运行 · {scope || "默认配置"}</div>
          <div className="mt-3 flex gap-4"><Link to="/sessions" className="hover:text-foreground">控制台</Link>{isDashboardEmbeddedChatEnabled() && <Link to="/chat" className="hover:text-foreground">终端聊天</Link>}</div>
        </div>
      </aside>

      {menuRow && actionMenu && <div ref={actionMenuRef} role="menu" aria-label={`会话操作：${menuRow.title}`} className="fixed z-40 w-44 rounded-lg border border-border bg-card p-1 shadow-xl" style={{ left: actionMenu.x, top: actionMenu.y }}>
        <button autoFocus role="menuitem" data-action="rename" className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => openActionDialog("rename")}><Pencil size={15} />重命名</button>
        <button role="menuitem" data-action="delete" disabled={menuRow.running} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-destructive hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50" onClick={() => openActionDialog("delete")}><Trash2 size={15} />删除</button>
        {menuRow.running && <div className="px-3 pb-1 text-xs text-muted-foreground">请先停止正在运行的任务</div>}
      </div>}

      {actionDialog && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4" onKeyDown={(event) => { if (event.key === "Escape" && !actionBusy) setActionDialog(null); }}>
        <div role="dialog" aria-modal="true" aria-label={actionDialog.kind === "rename" ? "重命名会话" : "删除会话"} className="w-full max-w-sm rounded-2xl border border-border bg-background p-5 shadow-2xl">
          <h2 className="text-lg font-semibold">{actionDialog.kind === "rename" ? "重命名会话" : "删除会话"}</h2>
          {actionDialog.kind === "rename" ? <input autoFocus aria-label="会话名称" value={actionTitle} onChange={(event) => setActionTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submitAction(); } }} className="mt-4 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary" />
            : <p className="mt-3 text-sm text-muted-foreground">确定删除“{actionDialog.title}”及其聊天记录吗？此操作无法撤销。{dialogRunning && "请先停止正在运行的任务。"}</p>}
          {actionError && <p role="alert" className="mt-3 text-sm text-destructive">{actionError}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <button disabled={actionBusy} onClick={() => setActionDialog(null)} className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50">取消</button>
            <button disabled={actionBusy || (actionDialog.kind === "delete" && dialogRunning)} aria-label={actionDialog.kind === "rename" ? "保存会话名称" : "确认删除会话"} onClick={() => void submitAction()} className={`rounded-lg px-3 py-2 text-sm text-primary-foreground disabled:opacity-50 ${actionDialog.kind === "delete" ? "bg-destructive" : "bg-primary"}`}>{actionBusy ? "处理中…" : actionDialog.kind === "rename" ? "保存" : "删除"}</button>
          </div>
        </div>
      </div>}

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 items-center gap-3 border-b border-border px-4">
          <button className="md:hidden" onClick={() => setSidebarOpen(true)} aria-label="打开会话列表"><Menu size={20} /></button>
          <h1 className="min-w-0 flex-1 truncate font-semibold">{selected?.title || "新对话"}</h1>
          {selected?.taskTiming && <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground" title={graphicalTaskTimingLabel(selected.taskTiming, clockNow)}>{graphicalTaskTimingLabel(selected.taskTiming, clockNow)}</span>}
          <span className="text-xs text-muted-foreground">{connection}</span>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto max-w-3xl space-y-6">
            {!selected?.messages.length && !selected?.streaming && <div className="py-24 text-center text-muted-foreground"><div className="text-2xl font-semibold text-foreground">开始与 Hermes 对话</div><p className="mt-3 text-sm">可以同时运行多个会话，切换会话不会停止后台任务。</p></div>}
            {selected?.messages.map((message) => (
              <div key={message.id} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm ${message.role === "user" ? "bg-primary/15" : "bg-card"}`}>
                  <div className="mb-2 text-xs font-semibold text-muted-foreground">{message.role === "user" ? "你" : message.role === "tool" ? "工具" : "Hermes"}</div>
                  {message.role === "assistant" ? <Markdown content={message.text} /> : <div className="whitespace-pre-wrap break-words">{message.text}</div>}
                  {message.taskTiming?.finished_at != null && <div className="mt-3 border-t border-border/60 pt-2 text-xs text-muted-foreground">{graphicalTaskTimingLabel(message.taskTiming)}</div>}
                </div>
              </div>
            ))}
            {selected?.streaming && <div className="max-w-[88%] rounded-2xl bg-card px-4 py-3"><div className="mb-2 text-xs font-semibold text-muted-foreground">Hermes</div><Markdown content={selected.streaming} streaming /></div>}
            {selected?.running && <div className="text-xs text-muted-foreground">● {selected.activity || "正在处理"}</div>}
            {selected?.error && <p className="text-sm text-destructive">{selected.error}</p>}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="border-t border-border px-4 pb-4 pt-3">
          <div className="mx-auto max-w-3xl">
            {pageError && <div role="alert" className="mb-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{pageError}</div>}
            {files.length > 0 && <div className="mb-2 flex flex-wrap gap-2">{files.map((file, index) => <span key={`${file.path}-${index}`} className="flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-xs">{file.name}<button onClick={() => setFiles((old) => old.filter((_, i) => i !== index))} aria-label={`移除 ${file.name}`}><X size={13} /></button></span>)}</div>}
            <div className="rounded-2xl border border-border bg-card p-3 shadow-sm" onPaste={(event) => { const pasted = [...event.clipboardData.files]; if (pasted.length) { event.preventDefault(); void upload(pasted); } }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void upload([...event.dataTransfer.files]); }}>
              <textarea className="min-h-20 w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground" placeholder="输入消息；可粘贴或拖入文件" value={draft} onChange={(event) => setDrafts((old) => ({ ...old, [draftKey]: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
              <div className="flex items-center gap-2">
                <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { void upload(Array.from(event.target.files || [])); event.target.value = ""; }} />
                <button className="rounded-lg p-2 hover:bg-muted" onClick={() => fileInputRef.current?.click()} title="添加文件" aria-label="添加文件"><Paperclip size={18} /></button>
                {uploading && <span className="text-xs text-muted-foreground">上传中…</span>}
                <div className="relative min-w-0 flex-1 text-right">
                  <button className="max-w-full truncate rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted" onClick={() => { setModelDraft(selected?.model || newModel); setModelOpen((open) => !open); }}>{selected?.model || newModel || "默认模型"}</button>
                  {modelOpen && <div className="absolute bottom-full right-0 z-10 mb-2 w-72 rounded-xl border border-border bg-background p-3 text-left shadow-xl">
                    <label className="mb-2 block text-xs text-muted-foreground">当前会话模型</label>
                    <input list="graphical-chat-models" className="w-full rounded-lg border border-border bg-background px-2 py-2 text-sm" value={modelDraft} onChange={(event) => setModelDraft(event.target.value)} placeholder="输入模型名称" />
                    <datalist id="graphical-chat-models">{modelNames.map((model) => <option key={model} value={model} />)}</datalist>
                    <button className="mt-2 rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-40" disabled={Boolean(selected && !selected.runtimeId) || !modelDraft.trim()} onClick={() => void chooseModel()}>应用</button>
                  </div>}
                </div>
                {selected?.running ? <button className="rounded-lg border border-destructive/50 p-2 text-destructive" onClick={() => void stop()} title="停止任务" aria-label="停止任务"><Square size={18} /></button> : <button className="rounded-lg bg-primary p-2 text-primary-foreground disabled:opacity-40" disabled={connection !== "已连接" || uploading || (!draft.trim() && !files.length)} onClick={() => void send()} title="发送" aria-label="发送"><Send size={18} /></button>}
              </div>
            </div>
          </div>
        </div>
      </main>
      {pending[0] && <GraphicalRequestCard key={pending[0].id} request={pending[0]} onDone={() => setPending((old) => old.filter((item) => item.id !== pending[0].id))} />}
    </div>
  );
}
