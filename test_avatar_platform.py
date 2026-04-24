#!/usr/bin/env python3
"""
Тест платформы ИИ-аватаров — запускать из терминала:
    python3 test_avatar_platform.py

Проверяет:
    1. ProfessionProfile — реестр профессий, system prompt
    2. UserProfile — психотип, эмоции, поведенческие паттерны
    3. MessageBus — отправка, broadcast, request-response
    4. TaskManager — CRUD задач, назначение, жизненный цикл
    5. AvatarFactory — создание аватаров под профессию
    6. AvatarInstance — обработка сообщений, делегирование задач
    7. AvatarNetwork — полный сценарий: команда из 4 аватаров решает задачу
"""

import asyncio
import sys
import os
import json
import datetime

# ─── helpers ──────────────────────────────────────────────────
PASSED = 0
FAILED = 0
ERRORS = []

def ok(name: str):
    global PASSED; PASSED += 1
    print(f"  OK  {name}")

def fail(name: str, detail: str = ""):
    global FAILED; FAILED += 1
    msg = f"  FAIL  {name}"
    if detail: msg += f" -- {detail}"
    print(msg); ERRORS.append(msg)

def section(title: str):
    print(f"\n{'='*60}\n  {title}\n{'='*60}")


# ═════════════════════════════════════════════════════════════
# 1. ProfessionProfile
# ═════════════════════════════════════════════════════════════
def test_profession_profile():
    section("1. ProfessionProfile -- реестр профессий")
    from avatar_platform.profession_profile import ProfessionProfile, PROFESSION_REGISTRY, get_profession

    # реестр не пуст
    assert len(PROFESSION_REGISTRY) >= 5, f"В реестре {len(PROFESSION_REGISTRY)} профессий (ожидали >= 5)"
    ok(f"реестр: {len(PROFESSION_REGISTRY)} профессий: {list(PROFESSION_REGISTRY.keys())}")

    # UX-дизайнер
    ux = get_profession("ux_designer")
    assert ux is not None
    assert "Figma" in ux.core_skills
    ok(f"ux_designer: skills={ux.core_skills[:3]}")

    # system prompt
    prompt = ux.build_system_prompt("Кристина")
    assert "Кристина" in prompt
    assert "UX" in prompt
    assert "wireframe" in prompt.lower() or "прототип" in prompt.lower()
    ok(f"system_prompt: {len(prompt)} символов, содержит имя и навыки")

    # несуществующая профессия
    assert get_profession("astronaut") is None
    ok("get_profession('astronaut') = None")


# ═════════════════════════════════════════════════════════════
# 2. UserProfile
# ═════════════════════════════════════════════════════════════
def test_user_profile():
    section("2. UserProfile -- психотип и эмоции")
    from avatar_platform.user_profile import UserProfile, BehaviorPattern

    user = UserProfile(user_id="u1", name="Кристина", role_id="ux_designer")

    # эмоции
    user.update_emotion("energy", 0.2)
    assert abs(user.emotional_state["energy"] - 0.9) < 0.01, f"got {user.emotional_state['energy']}"
    ok(f"update_emotion: energy = {user.emotional_state['energy']}")

    user.update_emotion("energy", 0.5)  # capped at 1.0
    assert user.emotional_state["energy"] == 1.0
    ok("emotion capped at 1.0")

    # поведенческие паттерны
    user.behavior_patterns = [
        BehaviorPattern(name="утро", trigger="8-12", effect={"energy": 0.1, "focus": 0.15}),
        BehaviorPattern(name="спад", trigger="13-15", effect={"energy": -0.1}),
    ]
    mods = user.apply_patterns(hour=9)  # утро
    assert mods.get("energy", 0) > 0
    ok(f"apply_patterns(9): mods={mods}")

    mods2 = user.apply_patterns(hour=20)  # вне паттернов
    assert len(mods2) == 0
    ok(f"apply_patterns(20): mods пусты (ожидаемо)")

    # delegation
    user.work_preferences["delegation_comfort"] = "высокий"
    level = user.get_delegation_level()
    assert level >= 0.8
    ok(f"delegation_level={level} (высокий)")

    # задачи
    user.record_task_result(approved=True)
    user.record_task_result(approved=True)
    user.record_task_result(approved=False)
    assert user.interaction_stats["tasks_approved"] == 2
    ok(f"task stats: {user.interaction_stats}")

    # serialization
    d = user.to_dict()
    user2 = UserProfile.from_dict(d)
    assert user2.name == "Кристина"
    assert user2.user_id == "u1"
    ok("to_dict / from_dict round-trip")

    # emotional summary
    summary = user.get_emotional_summary()
    assert isinstance(summary, str)
    ok(f"emotional_summary: '{summary}'")

    # avatar context
    ctx = user.build_avatar_context()
    assert "Кристина" in ctx
    ok(f"build_avatar_context: {len(ctx)} chars")


# ═════════════════════════════════════════════════════════════
# 3. MessageBus
# ═════════════════════════════════════════════════════════════
async def test_message_bus():
    section("3. MessageBus -- межаватарная коммуникация")
    from avatar_platform.message_bus import MessageBus, AvatarMessage

    bus = MessageBus()
    received = []

    async def handler_a(msg: AvatarMessage):
        received.append(("A", msg))
        return AvatarMessage(sender_id="a", recipient_id=msg.sender_id,
                             msg_type="response", subject="Re", body="ok from A",
                             reply_to=msg.id)

    async def handler_b(msg: AvatarMessage):
        received.append(("B", msg))
        return None

    bus.subscribe("a", handler_a)
    bus.subscribe("b", handler_b)
    ok(f"subscribed 2 avatars: {bus.get_stats()['subscribers']}")

    # direct message
    msg = AvatarMessage(sender_id="b", recipient_id="a", subject="ping", body="hello")
    reply = await bus.send(msg)
    assert reply is not None
    assert reply.body == "ok from A"
    ok(f"direct: b→a, reply='{reply.body}'")

    # broadcast
    received.clear()
    msg2 = AvatarMessage(sender_id="a", recipient_id="*", subject="broadcast", body="all")
    await bus.send(msg2)
    await asyncio.sleep(0.1)  # дать время broadcast таскам
    assert any(who == "B" for who, _ in received)
    ok(f"broadcast: получили {len(received)} подписчиков")

    # send_and_wait
    msg3 = AvatarMessage(sender_id="b", recipient_id="a", subject="sync-req", body="need data")
    reply3 = await bus.send_and_wait(msg3, timeout=5.0)
    assert reply3 is not None
    ok(f"send_and_wait: reply='{reply3.body}'")

    # history
    history = bus.get_history(limit=10)
    assert len(history) >= 3
    ok(f"history: {len(history)} сообщений")

    # stats
    stats = bus.get_stats()
    assert stats["total_messages"] >= 3
    ok(f"stats: {stats}")


# ═════════════════════════════════════════════════════════════
# 4. TaskManager
# ═════════════════════════════════════════════════════════════
def test_task_manager():
    section("4. TaskManager -- управление задачами")
    from avatar_platform.task_manager import TaskManager, TaskStatus, TaskPriority

    tm = TaskManager()

    # create
    task = tm.create_task("Сделать wireframe", "Главная страница приложения",
                          created_by="avatar_ux_u1", priority=TaskPriority.HIGH,
                          required_skills=["wireframing", "Figma"])
    assert task.id
    assert task.status == TaskStatus.CREATED
    ok(f"create: id={task.id}, status={task.status.value}")

    # assign
    tm.assign_task(task.id, "avatar_frontend_u2")
    assert task.status == TaskStatus.ASSIGNED
    ok(f"assign: → avatar_frontend_u2")

    # find best executor
    available = {
        "avatar_backend_u3": ["Python", "FastAPI", "PostgreSQL"],
        "avatar_ux_u4": ["wireframing", "Figma", "прототипирование"],
    }
    best = tm.find_best_executor(task, available)
    assert best == "avatar_ux_u4"
    ok(f"find_best_executor: {best}")

    # lifecycle
    tm.start_task(task.id)
    assert task.status == TaskStatus.IN_PROGRESS
    ok(f"start_task: {task.status.value}")

    tm.propose_solution(task.id, "wireframe + Figma", "Подготовлю lo-fi wireframe")
    assert len(task.proposed_solutions) == 1
    ok(f"propose_solution: {task.proposed_solutions[0]['method']}")

    tm.submit_result(task.id, "Wireframe готов: link.figma.com/xxx")
    assert task.status == TaskStatus.REVIEW
    ok(f"submit_result: {task.status.value}")

    tm.approve_task(task.id)
    assert task.status == TaskStatus.DONE
    ok(f"approve_task: {task.status.value}")

    # stats
    stats = tm.get_stats()
    assert stats["total_tasks"] == 1
    ok(f"stats: {stats}")


# ═════════════════════════════════════════════════════════════
# 5. AvatarFactory
# ═════════════════════════════════════════════════════════════
def test_avatar_factory():
    section("5. AvatarFactory -- создание аватаров")
    from avatar_platform.avatar_factory import AvatarFactory
    from avatar_platform.message_bus import MessageBus
    from avatar_platform.task_manager import TaskManager

    bus = MessageBus()
    tm = TaskManager()
    factory = AvatarFactory(message_bus=bus, task_manager=tm)

    # список профессий
    profs = factory.list_available_professions()
    assert len(profs) >= 5
    ok(f"available professions: {profs}")

    # создание UX-дизайнера
    avatar = factory.create_avatar(
        user_id="kristina_01",
        name="Кристина",
        role_id="ux_designer",
        personality={"openness": 0.8, "extraversion": 0.7},
    )
    assert avatar.avatar_id == "avatar_ux_designer_kristina_01"
    assert avatar.name == "Кристина"
    assert avatar.role == "UX-дизайнер"
    ok(f"created: {avatar.avatar_id}, role={avatar.role}")

    # prompt
    prompt = avatar.build_system_prompt()
    assert "Кристина" in prompt
    assert "автоном" in prompt.lower() or "решения" in prompt.lower()
    ok(f"system_prompt: {len(prompt)} chars")

    # ошибка для несуществующей профессии
    try:
        factory.create_avatar("x", "X", "astronaut")
        fail("должна быть ошибка для 'astronaut'")
    except ValueError:
        ok("ValueError для неизвестной профессии")


# ═════════════════════════════════════════════════════════════
# 6. AvatarInstance -- межаватарное взаимодействие
# ═════════════════════════════════════════════════════════════
async def test_avatar_instance():
    section("6. AvatarInstance -- взаимодействие аватаров")
    from avatar_platform.avatar_factory import AvatarFactory
    from avatar_platform.message_bus import MessageBus
    from avatar_platform.task_manager import TaskManager

    bus = MessageBus()
    tm = TaskManager()
    factory = AvatarFactory(message_bus=bus, task_manager=tm)

    # создаём двух аватаров
    ux = factory.create_avatar("k1", "Кристина", "ux_designer")
    be = factory.create_avatar("a1", "Артём", "backend_dev")

    # отправка сообщения (теперь через MockLLM)
    reply = await ux.send_message(be.avatar_id, "Нужен API", "Подготовь эндпоинт /users")
    assert reply is not None
    assert len(reply.body) > 10  # LLM вернул осмысленный ответ
    ok(f"ux → backend (LLM): reply='{reply.body[:60]}...'")

    # request_help
    reply2 = await ux.request_help(be.avatar_id, "Помощь с БД", "Какую структуру таблицы предлагаешь?", timeout=5.0)
    assert reply2 is not None
    ok(f"request_help: reply='{reply2.body[:60]}...'")

    # делегирование задачи (LLM генерирует решение)
    reply3 = await ux.delegate_task(be.avatar_id, "Сделать API /wireframes", "CRUD для wireframes")
    assert reply3 is not None
    assert "Предлагаю решение" in reply3.body  # формат сохраняется
    ok(f"delegate_task (LLM): reply='{reply3.body[:80]}...'")

    # проверка что задача создана в TaskManager
    tasks = tm.list_tasks()
    assert len(tasks) >= 1
    ok(f"TaskManager: {len(tasks)} задач создано")

    # статус аватара
    status = ux.get_status()
    assert status["name"] == "Кристина"
    assert status["inbox_count"] >= 0
    ok(f"status: {status}")


# ═════════════════════════════════════════════════════════════
# 7. AvatarNetwork -- полный сценарий команды
# ═════════════════════════════════════════════════════════════
async def test_avatar_network():
    section("7. AvatarNetwork -- полный сценарий команды")
    from avatar_platform.avatar_network import AvatarNetwork
    from avatar_platform.task_manager import TaskPriority

    net = AvatarNetwork()

    # добавляем команду из 4 человек
    ux = net.add_avatar("k1", "Кристина", "ux_designer",
                        personality={"openness": 0.8, "extraversion": 0.7})
    be = net.add_avatar("a1", "Артём", "backend_dev",
                        personality={"conscientiousness": 0.9})
    pm = net.add_avatar("m1", "Мария", "pm",
                        personality={"extraversion": 0.8, "agreeableness": 0.7})
    qa = net.add_avatar("o1", "Олег", "qa",
                        personality={"conscientiousness": 0.8, "neuroticism": 0.3})

    ok(f"команда: {[a.name for a in [ux, be, pm, qa]]}")

    # список аватаров
    avatars_list = net.list_avatars()
    assert len(avatars_list) == 4
    ok(f"list_avatars: {len(avatars_list)}")

    # поиск по роли
    ux_avatars = net.find_by_role("ux_designer")
    assert len(ux_avatars) == 1 and ux_avatars[0].name == "Кристина"
    ok(f"find_by_role('ux_designer'): {ux_avatars[0].name}")

    # поиск по навыку
    figma_avatars = net.find_by_skill("Figma")
    assert len(figma_avatars) >= 1
    ok(f"find_by_skill('Figma'): {[a.name for a in figma_avatars]}")

    # автоматическое создание и назначение задачи
    task = net.create_and_assign_task(
        title="Написать unit-тесты для /api/users",
        description="Покрыть CRUD операции тестами",
        created_by=pm.avatar_id,
        required_skills=["тестирование", "автотесты"],
        priority=TaskPriority.HIGH,
    )
    assert task is not None
    assert task.assigned_to == qa.avatar_id  # QA лучше всех подходит
    ok(f"auto-assign: '{task.title}' → {task.assigned_to}")

    # ещё задача — UX
    task2 = net.create_and_assign_task(
        title="Сделать прототип главной страницы",
        description="Lo-fi wireframe + user flow",
        created_by=pm.avatar_id,
        required_skills=["прототипирование", "wireframing"],
    )
    assert task2 is not None
    assert task2.assigned_to == ux.avatar_id
    ok(f"auto-assign: '{task2.title}' → {task2.assigned_to}")

    # межаватарное общение: PM просит Кристину помочь
    reply = await pm.request_help(
        ux.avatar_id,
        "Нужна помощь с CJM",
        "Составь Customer Journey Map для нового онбординга",
        timeout=5.0,
    )
    assert reply is not None
    ok(f"PM → UX: '{reply.body[:60]}...'")

    # Кристина делегирует подзадачу Артёму
    reply2 = await ux.delegate_task(
        be.avatar_id,
        "API для онбординга",
        "Нужен эндпоинт POST /onboarding/steps"
    )
    assert reply2 is not None
    assert "решение" in reply2.body.lower() or "Предлагаю" in reply2.body
    ok(f"UX → Backend (LLM): '{reply2.body[:60]}...'")

    # сетевая статистика
    stats = net.get_network_stats()
    assert stats["total_avatars"] == 4
    assert stats["tasks"]["total_tasks"] >= 2
    assert stats["message_bus"]["total_messages"] >= 2
    ok(f"network stats: avatars={stats['total_avatars']}, "
       f"tasks={stats['tasks']['total_tasks']}, "
       f"messages={stats['message_bus']['total_messages']}")

    print(f"\n    Полный сценарий команды завершён успешно.")


# ═════════════════════════════════════════════════════════════
# MAIN
# ═════════════════════════════════════════════════════════════
async def main():
    print("\n" + "=" * 60)
    print("  KRISTINA AVATAR PLATFORM TEST")
    print(f"  {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)

    test_profession_profile()
    test_user_profile()
    await test_message_bus()
    test_task_manager()
    test_avatar_factory()
    await test_avatar_instance()
    await test_avatar_network()

    section("ИТОГИ")
    total = PASSED + FAILED
    print(f"  Всего:   {total}")
    print(f"  Passed:  {PASSED}")
    print(f"  Failed:  {FAILED}")
    if ERRORS:
        print(f"\n  Ошибки:")
        for e in ERRORS: print(f"    {e}")
    print()
    if FAILED > 0:
        print("  ЕСТЬ ОШИБКИ")
        sys.exit(1)
    else:
        print("  ВСЕ ТЕСТЫ ПРОЙДЕНЫ")
        sys.exit(0)


if __name__ == "__main__":
    asyncio.run(main())
