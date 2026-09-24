"""任务耗时跨后台接续和 profile 恢复，旧历史只使用有依据的时间戳。"""

import copy
import threading
from types import SimpleNamespace

from hermes_state import SessionDB
from agent import secret_scope
from tui_gateway import server, task_timing
from tui_gateway.contracts.common import TaskTiming


def test_task_elapsed_survives_background_continuation_and_profile_round_trip(tmp_path, monkeypatch):
    """真实数据库 A→B→A；后台结束后的回复才冻结，刷新不会累计闲置时间。"""
    clock = [1_800_000_000.0]
    monkeypatch.setattr(task_timing, "time", SimpleNamespace(time=lambda: clock[0]))
    homes = [tmp_path / "a", tmp_path / "b"]
    databases = [SessionDB(home / "state.db") for home in homes]
    sessions = [{"session_key": "same-key", "profile_home": str(home), "history": [],
                 "history_lock": threading.Lock()} for home in homes]
    monkeypatch.setattr(secret_scope, "_MULTIPLEX_ACTIVE", True)
    try:
        for db in databases:
            db.create_session("same-key", source="tui")
        db, session = databases[0], sessions[0]
        start = clock[0]
        db.append_message("same-key", "user", "生成教学 PPT", timestamp=start)
        session["inflight_turn"] = {"started_at": start}
        assert task_timing.begin_task_timing(session, "生成教学 PPT")["started_at"] == start
        db._execute_write(lambda conn: conn.execute(
            "INSERT INTO async_delegations (delegation_id, origin_session, state, dispatched_at, updated_at) "
            "VALUES ('job', 'same-key', 'running', ?, ?)", (start + 1, start + 1)))
        clock[0] += 100
        db.append_message("same-key", "assistant", "插图正在后台生成", timestamp=clock[0])
        pending = task_timing.finish_task_timing("ui-a", session, "插图正在后台生成", "complete")
        assert pending["status"] == "waiting" and pending["finished_at"] is None
        db._execute_write(lambda conn: conn.execute(
            "UPDATE async_delegations SET state='completed', delivery_state='delivered'"))
        clock[0] += 200
        session.pop("task_timing")
        resumed = task_timing.begin_task_timing(session, "结果已返回", "async_delegation_complete")
        assert resumed["started_at"] == start
        db.append_message("same-key", "user", "结果已返回", timestamp=clock[0],
                          display_kind="async_delegation_complete")
        clock[0] = start + 4266
        db.append_message("same-key", "assistant", "已完成 PPT", timestamp=clock[0])
        done = task_timing.finish_task_timing("ui-a", session, "已完成 PPT", "complete")
        assert done["finished_at"] - done["started_at"] == 4266
        TaskTiming.model_validate(done)

        # 相同会话标识存在于不同 profile，恢复时不得串用数据库或计时状态。
        databases[1].append_message("same-key", "user", "另一个任务", timestamp=start + 5000)
        databases[1].append_message("same-key", "assistant", "完成", timestamp=start + 5012)
        b = task_timing.restored_task_timing(sessions[1])
        assert b["finished_at"] - b["started_at"] == 12 and b["approximate"]
        clock[0] += 7200
        session.pop("task_timing")
        assert task_timing.restored_task_timing(session) == done
        history = db.get_messages_as_conversation("same-key", include_row_ids=True)
        original = copy.deepcopy(history)
        projected = server._history_to_messages(history)
        footers = [m for m in projected if m.get("task_timing")]
        assert len(footers) == 1 and footers[0]["text"] == "已完成 PPT"
        assert footers[0]["task_timing"] == done
        assert history == original

        # 新输入建立新起点，失败和中断也有终止时间，不会继承前一任务的闲置时间。
        session["inflight_turn"] = {"started_at": clock[0]}
        fresh = task_timing.begin_task_timing(session, "继续修改")
        assert fresh["started_at"] == clock[0] > done["finished_at"]
        assert task_timing.finish_task_timing("ui-a", session, "", "interrupted")["finished_at"] == clock[0]
        assert task_timing.finish_task_timing("ui-a", session, "", "complete") is None
        task_timing.begin_task_timing(session, "再次修改")
        assert task_timing.finish_task_timing("ui-a", session, "", "error")["status"] == "error"

        # 使用真实进程注册表验证：等待运行或排队的结束通知，已处理的通知及常驻服务不阻塞。
        from tools import process_registry as processes
        registry = processes.ProcessRegistry()
        monkeypatch.setattr(processes, "process_registry", registry)
        process = processes.ProcessSession("proc-timing", "test", session_key="same-key",
                                           started_at=clock[0], notify_on_complete=True)
        registry._running[process.id] = process
        with server._session_profile_runtime_scope(session):
            assert task_timing._background_pending("ui-a", session)
            process.exited = True
            registry.completion_queue.put({"type": "completion", "session_id": process.id})
            assert task_timing._background_pending("ui-a", session)
            registry.completion_queue.get_nowait()
            assert not task_timing._background_pending("ui-a", session)
            process.exited, process.notify_on_complete = False, False
            assert not task_timing._background_pending("ui-a", session)
    finally:
        for db in databases:
            db.close()


def test_legacy_history_groups_real_prompts_and_never_invents_missing_time():
    history = [
        {"role": "user", "content": "生成课件", "timestamp": 1000},
        {"role": "assistant", "content": "开始生成", "timestamp": 1100},
        {"role": "user", "content": "[IMPORTANT: Background process x completed normally]", "timestamp": 1200},
        {"role": "assistant", "content": "开始排版", "timestamp": 1300},
        {"role": "user", "content": "[ASYNC DELEGATION BATCH COMPLETE — x] 结果", "timestamp": 1400},
        {"role": "assistant", "content": "课件完成", "timestamp": 1500},
        {"role": "user", "content": "缺少起点"},
        {"role": "assistant", "content": "不能计算", "timestamp": 1600},
        {"role": "user", "content": "时钟倒退", "timestamp": 1800},
        {"role": "assistant", "content": "不能计算", "timestamp": 1700},
        {"role": "user", "content": "缺少最终时间", "timestamp": 2000},
        {"role": "assistant", "content": "中间进度", "timestamp": 2100},
        {"role": "assistant", "content": "最后回复没有时间戳"},
    ]
    timings = task_timing.history_task_timings(history)
    assert list(timings) == [5]
    assert timings[5] == {"started_at": 1000, "finished_at": 1500, "status": "complete", "approximate": True}
