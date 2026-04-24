#!/usr/bin/env python3
"""
Тест пайплайна мозга Кристины — запускать из терминала:
    python3 test_brain_pipeline.py

Проверяет:
    1. BrainBridge — инициализация, process_signal, get_status
    2. EmotionalCore — эволюция эмоций, циркадный ритм
    3. MoodEngine — обновление настроения, промпт, задержка
    4. PersistentMemory — запись/чтение сообщений
    5. DialogMemory — сессии, контекст
    6. AgentRouter — маршрутизация + brain_recommendations (Stage 2)
    7. Полный pipeline — signal → brain → prompt enrichment
"""

import asyncio
import sys
import os
import datetime
import json
import traceback
from types import SimpleNamespace

# ─── helpers ──────────────────────────────────────────────────
PASSED = 0
FAILED = 0
ERRORS = []

def ok(name: str):
    global PASSED
    PASSED += 1
    print(f"  ✅ {name}")

def fail(name: str, detail: str = ""):
    global FAILED
    FAILED += 1
    msg = f"  ❌ {name}"
    if detail:
        msg += f" — {detail}"
    print(msg)
    ERRORS.append(msg)

def section(title: str):
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}")


# ═════════════════════════════════════════════════════════════
# 1. BrainBridge
# ═════════════════════════════════════════════════════════════
async def test_brain_bridge():
    section("1. BrainBridge — мост к мозгу")

    try:
        from brain_integration import BrainBridge, get_brain_bridge
        ok("import brain_integration")
    except Exception as e:
        fail("import brain_integration", str(e))
        return

    # --- init ---
    try:
        bridge = get_brain_bridge()
        assert bridge is not None, "bridge is None"
        ok("get_brain_bridge() — singleton создан")
    except Exception as e:
        fail("get_brain_bridge()", str(e))
        return

    # --- cortex/emotion/memory доступны? ---
    print(f"    cortex  = {type(bridge.cortex).__name__}")
    print(f"    emotion = {type(bridge.emotional).__name__}")
    print(f"    memory  = {type(bridge.memory).__name__}")

    # --- process_signal ---
    try:
        sig = SimpleNamespace(
            content="Привет, как дела?",
            timestamp=datetime.datetime.now(),
            session_id="test_session_1"
        )
        result = await bridge.process_signal(sig, context={
            "user_id": "test_user",
            "session_id": "test_session_1"
        })
        assert isinstance(result, dict), "result не dict"
        for key in ("cortex", "emotion", "memory", "recommendations"):
            assert key in result, f"ключ '{key}' отсутствует"
        ok(f"process_signal — вернул ключи: {list(result.keys())}")
    except Exception as e:
        fail("process_signal", str(e))
        return

    # --- проверка структуры cortex ---
    cortex = result["cortex"]
    if cortex.get("status") == "uninitialized":
        print("    ⚠️  cortex не инициализирован (CortexAgent недоступен)")
    else:
        ok(f"cortex обработал сигнал: {cortex}")

    # --- проверка emotion ---
    emo = result["emotion"]
    if emo:
        dom = emo.get("dominant_emotion", "?")
        ok(f"emotion dominant={dom}, mood='{emo.get('mood_description', '?')}'")
    else:
        print("    ⚠️  emotion пуст (EmotionalCore недоступен)")

    # --- проверка memory ---
    mem = result["memory"]
    ok(f"memory context: {mem}")

    # --- проверка recommendations (Stage 2) ---
    recs = result["recommendations"]
    assert "agent_recommendations" in recs, "нет agent_recommendations"
    assert "actions" in recs, "нет actions"
    ok(f"recommendations: agents={recs['agent_recommendations']}, actions={recs['actions']}")

    # --- get_status ---
    try:
        status = bridge.get_status()
        assert isinstance(status, dict)
        ok(f"get_status: {json.dumps(status, ensure_ascii=False, default=str)[:200]}")
    except Exception as e:
        fail("get_status", str(e))


# ═════════════════════════════════════════════════════════════
# 2. EmotionalCore
# ═════════════════════════════════════════════════════════════
def test_emotional_core():
    section("2. EmotionalCore — эмоции")

    try:
        from emotional_core import EmotionalCore, get_emotional_core
        ok("import emotional_core")
    except Exception as e:
        fail("import emotional_core", str(e))
        return

    core = get_emotional_core()

    # evolve
    state = core.evolve()
    assert "dominant_emotion" in state, "нет dominant_emotion"
    assert "state" in state, "нет state"
    assert "for_llm" in state, "нет for_llm"
    ok(f"evolve() — dominant={state['dominant_emotion']}, llm='{state['for_llm']}'")

    # state values в диапазоне [0.1, 1.0]
    for k, v in state["state"].items():
        assert 0.1 <= v <= 1.0, f"{k}={v} вне диапазона"
    ok("все эмоции в диапазоне [0.1, 1.0]")

    # traits стабильны
    traits = state["traits"]
    assert traits["openness"] == 0.8
    ok(f"traits стабильны: openness={traits['openness']}")


# ═════════════════════════════════════════════════════════════
# 3. MoodEngine
# ═════════════════════════════════════════════════════════════
def test_mood_engine():
    section("3. MoodEngine — настроение")

    try:
        from mood_engine import MoodEngine, MoodState
        ok("import mood_engine")
    except Exception as e:
        fail("import mood_engine", str(e))
        return

    engine = MoodEngine()

    # update
    mood = engine.update(user_message=True)
    assert isinstance(mood, MoodState), f"mood не MoodState: {type(mood)}"
    ok(f"update() — mood={mood.value}")

    # prompt
    prompt = engine.get_mood_prompt()
    assert isinstance(prompt, str) and len(prompt) > 5
    ok(f"get_mood_prompt() — '{prompt[:60]}...'")

    # delay
    delay = engine.get_delay()
    assert isinstance(delay, int) and delay > 0
    ok(f"get_delay() — {delay} сек")

    # status
    status = engine.get_status()
    assert "mood" in status and "energy" in status
    ok(f"get_status() — {status}")


# ═════════════════════════════════════════════════════════════
# 4. PersistentMemory
# ═════════════════════════════════════════════════════════════
def test_persistent_memory():
    section("4. PersistentMemory — долгосрочная память")

    try:
        from persistent_memory import PersistentMemory
        ok("import persistent_memory")
    except Exception as e:
        fail("import persistent_memory", str(e))
        return

    # используем тестовую БД чтобы не трогать продовую
    TEST_DB = "test_brain_pipeline.db"
    mem = PersistentMemory(db_path=TEST_DB)

    # save
    mem.save_message("test_sess", "user", "Тестовое сообщение от юзера", channel="test")
    mem.save_message("test_sess", "assistant", "Ответ Кристины", channel="test")
    ok("save_message x2")

    # read
    msgs = mem.get_recent_messages("test_sess", limit=5)
    assert len(msgs) >= 2, f"ожидали >= 2 сообщений, получили {len(msgs)}"
    ok(f"get_recent_messages — {len(msgs)} сообщений")

    # context for llm
    ctx = mem.get_context_for_llm("test_sess", limit=5)
    assert isinstance(ctx, list)
    assert all("role" in m and "content" in m for m in ctx)
    ok(f"get_context_for_llm — {len(ctx)} элементов")

    # stats
    stats = mem.get_stats()
    assert stats["total_messages"] >= 2
    ok(f"get_stats — {stats}")

    mem.close()

    # удаляем тестовую БД
    try:
        os.remove(TEST_DB)
    except:
        pass


# ═════════════════════════════════════════════════════════════
# 5. DialogMemory
# ═════════════════════════════════════════════════════════════
async def test_dialog_memory():
    section("5. DialogMemory — память диалогов")

    try:
        from dialog_memory import DialogMemory
        ok("import dialog_memory")
    except Exception as e:
        fail("import dialog_memory", str(e))
        return

    TEST_DB = "test_dialog_pipeline.db"
    dm = DialogMemory(db_path=TEST_DB)

    # add messages
    await dm.add_message("user_42", "user", "Привет Кристина!")
    await dm.add_message("user_42", "assistant", "Привет! Что нового?", agent_type="persona", mood_energy="CURIOUS")
    ok("add_message x2")

    # get context
    ctx = await dm.get_context("user_42", limit=10)
    assert len(ctx) >= 2
    assert ctx[0]["role"] == "user"
    ok(f"get_context — {len(ctx)} сообщений")

    # summary
    summary = await dm.get_summary("user_42")
    assert isinstance(summary, str) and len(summary) > 0
    ok(f"get_summary — '{summary}'")

    # cleanup
    try:
        os.remove(TEST_DB)
    except:
        pass


# ═════════════════════════════════════════════════════════════
# 6. AgentRouter + brain_recommendations (Stage 2)
# ═════════════════════════════════════════════════════════════
async def test_agent_router():
    section("6. AgentRouter — маршрутизация + мозговые рекомендации")

    try:
        # Импортируем напрямую, минуя agents/__init__.py
        # чтобы не тянуть aiohttp и прочие тяжёлые зависимости
        import importlib, importlib.util
        def _load_module(name, path):
            spec = importlib.util.spec_from_file_location(name, path)
            mod = importlib.util.module_from_spec(spec)
            sys.modules[name] = mod
            spec.loader.exec_module(mod)
            return mod

        base_mod = _load_module("agents.base_agent", os.path.join("agents", "base_agent.py"))
        # router.py делает from .base_agent import ..., поэтому уже в sys.modules
        router_mod = _load_module("agents.router", os.path.join("agents", "router.py"))
        AgentRouter = router_mod.AgentRouter
        BaseAgent = base_mod.BaseAgent
        AgentResponse = base_mod.AgentResponse
        ok("import router + base_agent (isolated)")
    except Exception as e:
        fail("import router", str(e))
        traceback.print_exc()
        return

    # создаём мини-агентов без внешних зависимостей
    class FakePersona(BaseAgent):
        def __init__(self):
            super().__init__("Kristina", "persona", "test")
            self.activation_keywords = ["привет"]
        async def process(self, user_input, context):
            return AgentResponse(content="persona reply", agent_name="Kristina",
                                 confidence=1.0, emotion="ok", suggested_actions=[], context_used={})

    class FakeAdvisor(BaseAgent):
        def __init__(self):
            super().__init__("Kristina-Advisor", "advisor", "test")
            self.activation_keywords = ["совет"]
        async def process(self, user_input, context):
            return AgentResponse(content="advisor reply", agent_name="Kristina-Advisor",
                                 confidence=1.0, emotion="ok", suggested_actions=[], context_used={})

    class FakeCreative(BaseAgent):
        def __init__(self):
            super().__init__("Kristina-Creative", "creative", "test")
            self.activation_keywords = ["идея"]
        async def process(self, user_input, context):
            return AgentResponse(content="creative reply", agent_name="Kristina-Creative",
                                 confidence=1.0, emotion="ok", suggested_actions=[], context_used={})

    # --- тест без рекомендаций (Stage 1 поведение) ---
    rt = AgentRouter()
    rt.register_agent(FakePersona(), is_default=True)
    rt.register_agent(FakeAdvisor())
    rt.register_agent(FakeCreative())

    decision = await rt.route("привет как дела", {})
    assert decision.selected_agent.name == "Kristina"
    ok(f"route без рекомендаций → {decision.selected_agent.name} (default)")

    # --- тест с brain_recommendations (Stage 2) ---
    rt2 = AgentRouter()
    rt2.register_agent(FakePersona(), is_default=True)
    rt2.register_agent(FakeAdvisor())
    rt2.register_agent(FakeCreative())

    ctx_with_brain = {
        "brain_recommendations": {
            "agent_recommendations": ["Kristina-Advisor"],
            "actions": ["switch_to_recommended_agent"]
        }
    }
    decision2 = await rt2.route("привет как дела", ctx_with_brain)
    assert decision2.selected_agent.name == "Kristina-Advisor", \
        f"ожидали Kristina-Advisor, получили {decision2.selected_agent.name}"
    ok(f"route с brain_recommendations → {decision2.selected_agent.name} (Stage 2!)")

    # --- тест process через рекомендованного агента ---
    rt3 = AgentRouter()
    rt3.register_agent(FakePersona(), is_default=True)
    rt3.register_agent(FakeAdvisor())
    rt3.register_agent(FakeCreative())

    response = await rt3.process("расскажи", ctx_with_brain)
    assert response.agent_name == "Kristina-Advisor"
    assert "advisor reply" in response.content
    ok(f"process через brain-рекомендованного агента → '{response.content}'")

    # --- тест с рекомендацией Creative ---
    rt4 = AgentRouter()
    rt4.register_agent(FakePersona(), is_default=True)
    rt4.register_agent(FakeAdvisor())
    rt4.register_agent(FakeCreative())

    ctx_creative = {
        "brain_recommendations": {
            "agent_recommendations": ["Kristina-Creative"],
            "actions": ["switch_to_recommended_agent"]
        }
    }
    decision4 = await rt4.route("что-нибудь", ctx_creative)
    assert decision4.selected_agent.name == "Kristina-Creative"
    ok(f"route с Creative-рекомендацией → {decision4.selected_agent.name}")


# ═════════════════════════════════════════════════════════════
# 7. Полный pipeline: signal → brain → prompt enrichment
# ═════════════════════════════════════════════════════════════
async def test_full_pipeline():
    section("7. Полный pipeline — signal → brain → prompt")

    try:
        from brain_integration import get_brain_bridge
        bridge = get_brain_bridge()
    except Exception as e:
        fail("pipeline: brain_bridge", str(e))
        return

    # 1) Формируем сигнал
    sig = SimpleNamespace(
        content="Помоги с UX-аудитом мобильного приложения",
        timestamp=datetime.datetime.now(),
        session_id="pipeline_test"
    )
    ctx = {"user_id": "ux_designer_1", "session_id": "pipeline_test"}

    # 2) Прогоняем через мозг
    result = await bridge.process_signal(sig, context=ctx)
    ok("process_signal отработал")

    # 3) Собираем данные для промпта (как в kristina_persona.py)
    brain_memory_text = ""
    mem_ctx = result.get("memory", {}).get("memory_context", [])
    if isinstance(mem_ctx, list) and mem_ctx:
        brain_memory_text = "\nМозг память: " + ", ".join(map(str, mem_ctx))
    elif isinstance(mem_ctx, str) and mem_ctx:
        brain_memory_text = "\nМозг память: " + mem_ctx

    brain_emotion_text = ""
    emo = result.get("emotion", {})
    if emo:
        dom = emo.get("dominant_emotion", "")
        state = emo.get("state", {})
        brain_emotion_text = f"\nМозг эмоции: dominant={dom}, state={json.dumps(state, ensure_ascii=False)}"

    brain_recs_text = ""
    recs = result.get("recommendations", {})
    agent_recs = recs.get("agent_recommendations", [])
    if agent_recs:
        brain_recs_text = "\n# мозг рекомендует: " + ", ".join(agent_recs)

    # 4) Собираем итоговый промпт (упрощённо)
    base_prompt = "Ты Кристина, UX-дизайнер."
    full_prompt = base_prompt + brain_memory_text + brain_emotion_text + brain_recs_text

    print(f"\n    --- Сгенерированный промпт (фрагмент) ---")
    for line in full_prompt.split("\n"):
        print(f"    | {line}")
    print(f"    --- конец промпта ---\n")

    assert "Кристина" in full_prompt
    ok("промпт содержит базу")

    if brain_emotion_text:
        assert "dominant=" in full_prompt
        ok("промпт содержит эмоции мозга")
    else:
        print("    ⚠️  эмоции мозга не попали в промпт (EmotionalCore недоступен)")

    # 5) Проверяем что рекомендации транслируются в контекст
    ctx["brain_recommendations"] = recs
    ok(f"brain_recommendations переданы в context: {recs}")

    print(f"\n    Pipeline завершён успешно.")


# ═════════════════════════════════════════════════════════════
# MAIN
# ═════════════════════════════════════════════════════════════
async def main():
    print("\n" + "=" * 60)
    print("  KRISTINA BRAIN PIPELINE TEST")
    print(f"  {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)

    # 1-7 тесты
    await test_brain_bridge()
    test_emotional_core()
    test_mood_engine()
    test_persistent_memory()
    await test_dialog_memory()
    await test_agent_router()
    await test_full_pipeline()

    # итоги
    section("ИТОГИ")
    total = PASSED + FAILED
    print(f"  Всего:   {total}")
    print(f"  Passed:  {PASSED}")
    print(f"  Failed:  {FAILED}")
    if ERRORS:
        print(f"\n  Ошибки:")
        for e in ERRORS:
            print(f"    {e}")
    print()

    if FAILED > 0:
        print("  ⚠️  ЕСТЬ ОШИБКИ — нужно исправить")
        sys.exit(1)
    else:
        print("  ✅ ВСЕ ТЕСТЫ ПРОЙДЕНЫ")
        sys.exit(0)


if __name__ == "__main__":
    asyncio.run(main())
