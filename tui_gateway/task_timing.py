"""任务计时仅用于展示，不进入模型上下文；后台接续共享真实用户需求的起点。"""

from __future__ import annotations

import logging
import math
import time

from agent.context_compressor import is_compaction_summary_message, user_originated_turn_view

logger = logging.getLogger(__name__)


def _timestamp(value) -> float | None:
    """不把缺失、无效或布尔值时间戳当作可用记录。"""
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0:
        return float(value)
    return None


def is_task_prompt(message: dict) -> bool:
    """纠偏及后台唤醒不是新任务，旧版通知也沿用既有的用户来源识别规则。"""
    if message.get("display_kind") == "steer":
        return False
    content = message.get("content")
    if isinstance(content, str) and content.lstrip().startswith((
        "[ASYNC DELEGATION", "[System note: Your previous turn was interrupted mid-run",
    )):
        return False
    return user_originated_turn_view(message) is not None


def _saved_timing(message: dict) -> dict | None:
    metadata = message.get("display_metadata")
    value = metadata.get("task_timing") if isinstance(metadata, dict) else None
    if not isinstance(value, dict) or _timestamp(value.get("started_at")) is None:
        return None
    return dict(value)


def history_task_timings(history: list[dict]) -> dict[int, dict]:
    """每条需求只在最后一条有效回复上放页脚；旧消息仅作时间戳估算。"""
    timings: dict[int, dict] = {}
    start = None
    last_reply = None
    for index, message in enumerate(history):
        if not isinstance(message, dict):
            continue
        if is_task_prompt(message):
            start, last_reply = _timestamp(message.get("timestamp")), None
            continue
        if (message.get("role") != "assistant" or message.get("tool_calls")
                or message.get("display_kind") == "hidden" or is_compaction_summary_message(message)
                or not message.get("content")):
            continue
        saved = _saved_timing(message)
        end = _timestamp(message.get("timestamp"))
        if last_reply is not None:
            timings.pop(last_reply, None)
            last_reply = None
        if saved is not None:
            start = saved["started_at"]
            timing = saved
        elif start is not None and end is not None and end >= start:
            timing = {"started_at": start, "finished_at": end, "status": "complete", "approximate": True}
        else:
            continue
        timings[index], last_reply = timing, index
    return timings


def _stored_history(session: dict) -> list[dict]:
    """数据库句柄跟随会话所属 profile，压缩后仍读取同一会话谱系。"""
    from tui_gateway import server

    key = str(session.get("session_key") or "")
    if key:
        with server._session_db(session) as db:
            if db is not None:
                return db.get_messages_as_conversation(key, include_ancestors=True, include_row_ids=True)
    return list(session.get("history") or [])


def restored_task_timing(session: dict) -> dict | None:
    """优先使用当前进程的状态，重启后从展示元数据或历史时间戳恢复。"""
    if isinstance(session.get("task_timing"), dict):
        return dict(session["task_timing"])
    history = _stored_history(session)
    timings = history_task_timings(history)
    last_index = next(reversed(timings), -1)
    for index in range(len(history) - 1, last_index, -1):
        if is_task_prompt(history[index]):
            start = _timestamp(history[index].get("timestamp"))
            return ({"started_at": start, "finished_at": None, "status": "running", "approximate": True}
                    if start is not None else None)
    return timings.get(last_index)


def begin_task_timing(session: dict, text, display_kind=None, display_metadata=None) -> dict | None:
    """在接收新需求时计时；自动续跑及后台结果不得重置起点。"""
    prompt = {"role": "user", "content": text, "display_kind": display_kind}
    if (display_metadata or {}).get("notification_category") == "diagnostic":
        return None
    if is_task_prompt(prompt):
        inflight = session.get("inflight_turn") or {}
        timing = {"started_at": _timestamp(inflight.get("started_at")) or time.time(),
                  "finished_at": None, "status": "running", "approximate": False}
    else:
        try:
            timing = restored_task_timing(session)
        except Exception:
            # 历史不可读时仍执行用户任务，但不伪造一个新的计时起点。
            logger.warning("恢复任务耗时失败", exc_info=True)
            timing = None
        if timing is None:
            return None
        timing.update(finished_at=None, status="running")
    session["task_timing"] = timing
    return dict(timing)


def _background_pending(sid: str, session: dict) -> bool:
    """只等待有完成回调的后台工作，预览服务器等常驻进程不延长任务计时。"""
    from tools.async_delegation import has_live_for_session
    from tools.process_registry import process_registry

    key = str(session.get("session_key") or "")
    if has_live_for_session(session_key=key, origin_ui_session_id=sid):
        return True
    registry = process_registry
    if key:
        # 不消费队列；已投递的结束通知不能让任务永远停留在等待状态。
        with registry.completion_queue.mutex:
            queued = {event.get("session_id") for event in registry.completion_queue.queue
                      if event.get("type", "completion") == "completion"}
        for process in registry.list_sessions(session_key=key):
            process_id = process["session_id"]
            pending = process["status"] == "running" or process_id in queued
            if pending and process.get("notify_on_complete") and not registry.is_completion_consumed(process_id):
                return True
    # 已结束的委派在回调尚未投递时仍属于同一任务，不能因注册表先变更而提前结算。
    from tui_gateway import server

    with server._session_db(session) as db:
        if db is not None and key:
            with db._read_ctx() as conn:
                return conn.execute(
                    "SELECT 1 FROM async_delegations WHERE (origin_session = ? OR origin_ui_session_id = ?) "
                    "AND delivery_state = 'pending' AND dispatched_at >= ? LIMIT 1",
                    (key, sid, (session.get("task_timing") or {}).get("started_at", 0)),
                ).fetchone() is not None
    return False


def finish_task_timing(sid: str, session: dict, text, status: str) -> dict | None:
    """冻结终止时间并保存到回复的展示元数据，正文和提示缓存保持不变。"""
    timing = session.get("task_timing")
    if (not isinstance(timing, dict) or timing.get("status") not in {"running", "waiting"}
            or session.get("_task_timing_suppressed")):
        return None
    timing = dict(timing)
    try:
        waiting = status == "complete" and _background_pending(sid, session)
    except Exception:
        # 展示状态查询失败不能使正常回复变成失败，也不能声称后台已完成。
        logger.warning("读取任务后台状态失败", exc_info=True)
        waiting = status == "complete"
        timing["approximate"] = True
    timing.update(status="waiting" if waiting else status, finished_at=None if waiting else time.time())
    session["task_timing"] = timing
    if isinstance(text, str) and text:
        from tui_gateway import server

        # 展示写入失败不影响任务交付；重开后仍可用原有消息时间戳显示估算。
        try:
            with server._session_db(session) as db:
                if db is not None:
                    key = str(session.get("session_key") or "")
                    history = db.get_messages_as_conversation(key, include_row_ids=True)
                    row = next((m for m in reversed(history)
                                if m.get("role") == "assistant" and m.get("content") == text), None)
                    if row is not None:
                        metadata = {**(row.get("display_metadata") or {}), "task_timing": timing}
                        db.set_latest_matching_message_display_kind(
                            key, role="assistant", content=text,
                            display_kind=row.get("display_kind") or "task_result", display_metadata=metadata)
        except Exception:
            logger.warning("保存任务耗时展示信息失败", exc_info=True)
    return dict(timing)
