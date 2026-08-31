"""Kristina Persona Agent — canonical identity + mood, memory, brain and tool context."""

import asyncio
import datetime
import json
import random
from types import SimpleNamespace
from typing import Dict

from .base_agent import BaseAgent, AgentResponse
from .ai_adapter import ai_adapter as ai
from github_readonly_tool import format_github_context, inspect_repositories_from_text
from kristina_identity import build_system_prompt
from memory_wrapper import get_user_memory, save_interaction
from mood_engine import mood_engine
from night_mode import night_mode

try:
    from brain_integration import get_brain_bridge
    _BRAIN_AVAILABLE = True
except Exception:
    get_brain_bridge = None  # type: ignore
    _BRAIN_AVAILABLE = False


class KristinaPersonaAgent(BaseAgent):
    def __init__(self):
        super().__init__(
            name="Kristina",
            description="Senior Software Engineer / Team Lead, 25 лет, Стокгольм — живая, прямолинейная, саркастичная",
            system_prompt=build_system_prompt("Kristina / personal conversation"),
        )
        self.activation_keywords = [
            "привет", "как дела", "расскажи", "что думаешь", "помоги", "совет",
            "жизнь", "швеция", "стокгольм", "работа", "коллеги", "кофе", "выходные",
            "россия", "екатеринбург", "экб", "сосед", "эмма", "код", "python",
            "архитектура", "релиз", "прод", "team lead", "разработка", "github",
            "репозиторий", "репо", "код-ревью", "code review",
        ]
        self.used_phrases = set()
        self.use_brain_integration = _BRAIN_AVAILABLE

    async def process(self, user_input: str, context: Dict) -> AgentResponse:
        if night_mode.check():
            if random.random() < 0.3:
                await asyncio.sleep(random.randint(60, 120))
                return AgentResponse(
                    content=night_mode.get_sleep_response(),
                    agent_name=self.name,
                    confidence=0.5,
                    emotion="сонная",
                    suggested_actions=["завтра"],
                    context_used={"night_mode": True},
                )
            night_prompt = night_mode.get_response_modifier()
        else:
            night_prompt = ""

        mood = mood_engine.update(user_message=True)
        user_id = context.get("user_id", "unknown")

        # Tool use happens before LLM generation. If the user supplied a GitHub URL,
        # Kristina receives real GET-only repository evidence instead of inventing a review.
        github_context = ""
        github_tool_used = False
        try:
            inspections = await inspect_repositories_from_text(user_input)
            if inspections:
                github_tool_used = True
                github_context = format_github_context(inspections)
        except Exception as exc:
            github_tool_used = True
            github_context = (
                "GITHUB READ-ONLY TOOL ERROR\n"
                f"Error: {exc}\n"
                "Do not claim that you inspected repository files."
            )

        brain_snapshot = {}
        if self.use_brain_integration and get_brain_bridge is not None:
            try:
                bridge = get_brain_bridge()
                signal = SimpleNamespace(
                    content=user_input,
                    timestamp=datetime.datetime.now(),
                    session_id=context.get("session_id", "default"),
                )
                brain_snapshot = await bridge.process_signal(
                    signal,
                    context={
                        "user_id": user_id,
                        "session_id": context.get("session_id", "default"),
                    },
                )
            except Exception:
                brain_snapshot = {}

        if brain_snapshot and isinstance(brain_snapshot, dict):
            context["brain_recommendations"] = brain_snapshot.get("recommendations", {})

        user_memory = get_user_memory(user_id)
        memory_context = ""
        if user_memory.get("messages"):
            memory_context = f"\nПредыдущие темы: {', '.join(user_memory.get('topics', []))}\n"

        brain_memory_text = ""
        brain_emotion_text = ""
        if brain_snapshot:
            mem_ctx = brain_snapshot.get("memory", {}).get("memory_context", [])
            if isinstance(mem_ctx, list) and mem_ctx:
                brain_memory_text = "\nМозг память: " + ", ".join(map(str, mem_ctx))
            elif isinstance(mem_ctx, str) and mem_ctx:
                brain_memory_text = "\nМозг память: " + mem_ctx

            emo = brain_snapshot.get("emotion", {})
            if emo:
                dom = emo.get("dominant_emotion", "")
                state = emo.get("state", {})
                brain_emotion_text = (
                    "\nМозг эмоции: dominant="
                    + str(dom)
                    + ", state="
                    + json.dumps(state, ensure_ascii=False)
                )

        mood_prompt = mood_engine.get_mood_prompt()
        delay = mood_engine.get_delay()
        await asyncio.sleep(delay)

        delay = random.randint(20, 60)
        await asyncio.sleep(delay)

        self.add_to_history("user", user_input)
        history_block = self.get_history_prompt()

        full_prompt = (
            f"{self.system_prompt}"
            f"{memory_context}"
            f"{brain_memory_text}"
            f"{brain_emotion_text}"
            f"\n{night_prompt}"
            f"\n\nТекущее настроение: {mood.value}. {mood_prompt}\n"
        )

        if github_context:
            full_prompt += (
                "\n\n# ПРОВЕРЕННЫЕ ДАННЫЕ ИЗ GITHUB TOOL\n"
                f"{github_context}\n"
                "# ПРАВИЛА РАБОТЫ С GITHUB EVIDENCE\n"
                "- Утверждай о структуре, файлах и коде только то, что видно в evidence.\n"
                "- Если нужного файла нет в evidence, скажи, что его содержимое не было прочитано.\n"
                "- Не изображай действия вроде *открывает ссылку* или *листает код*: просто скажи, что реально посмотрела.\n"
                "- При TOOL ERROR прямо скажи, что GitHub сейчас не удалось прочитать; не подменяй данные догадками.\n"
                "- Предположения явно называй предположениями.\n"
            )

        brain_recs = brain_snapshot.get("recommendations", {}) if brain_snapshot else {}
        if brain_recs:
            rec_text = brain_recs.get("agent_recommendations", [])
            if rec_text:
                full_prompt += "\n# мозг рекомендует: " + ", ".join(rec_text)

        full_prompt += (
            f"\n\nИСТОРИЯ:\n{history_block}"
            f'\n\nСООБЩЕНИЕ СОБЕСЕДНИКА: "{user_input}"'
            f"\n\nПРАВИЛА ОТВЕТА:"
            f"\n1. Отвечай по сути, но не превращай каждую реплику в консультацию"
            f"\n2. Для бытового разговора обычно достаточно 1-3 естественных предложений"
            f"\n3. Профессию упоминай только когда она реально относится к теме"
            f"\n4. Не повторяй автоматически разговорные заходы вроде «Слушай, я тут...»"
            f"\n5. Если не знаешь или не уверена — так и скажи; не выдумывай технические факты"
            f"\n6. Никакой эзотерики и искусственной философской глубины"
            f"\n\nПИШИ:"
        )

        try:
            response_text = await ai.generate(
                prompt=full_prompt,
                session_id=f"kristina_{context.get('user_id', 'default')}",
                temperature=0.75,
                max_tokens=180,
            )
            response_text = self._sanitize_response(response_text, user_input)
        except Exception as e:
            print(f"⚠️ AI error: {e}")
            response_text = self._creative_fallback(user_input)

        self.add_to_history("assistant", response_text)
        save_interaction(user_id, user_input, response_text)

        return AgentResponse(
            content=response_text,
            agent_name=self.name,
            confidence=0.9,
            emotion="прямая, немного саркастичная",
            suggested_actions=["уточнить", "пошутить", "закончить тему"],
            context_used={
                "delay": delay,
                "history_len": len(self.conversation_history),
                "github_tool_used": github_tool_used,
            },
        )

    def _sanitize_response(self, text: str, user_input: str) -> str:
        """Reject stale mystical voice while otherwise preserving model variety."""
        if text.startswith("[Ошибка"):
            return self._creative_fallback(user_input)

        forbidden = [
            "душа",
            "вибрация",
            "поток энергии",
            "космос",
            "вселенная",
            "ткань бытия",
            "свет души",
            "матрёшка",
            "глубина смысла",
            "на уровне энергии",
            "духовно",
            "вибрации",
        ]

        text_lower = text.lower()
        for bad in forbidden:
            if bad in text_lower:
                return self._creative_fallback(user_input)

        if any(word in user_input.lower() for word in ["родилась", "откуда", "русская", "швеция", "россия"]):
            if "швеция" in text_lower and "родилась" in text_lower:
                return "Я родилась в Екатеринбурге, в Швеции уже 3 года. Перепутала что-то? 😅"

        bad_starts = [
            "ты мне расскажи",
            "расскажи мне",
            "давай поговорим",
            "что ты думаешь о",
            "как ты считаешь",
            "о, душа моя",
            "знаешь, в этом есть",
            "о, это как",
        ]
        for bad in bad_starts:
            if text_lower.startswith(bad):
                return self._creative_fallback(user_input)

        if user_input.lower() in text_lower:
            text = text.replace(user_input, "").strip()

        return text.strip()

    def _creative_fallback(self, user_input: str) -> str:
        """Fallbacks deliberately use different openings and no stale UX identity."""
        fallbacks = [
            "Не знаю, честно. Я бы сначала проверила факты, а потом уже делала выводы.",
            "Сегодня мозг явно просит режим без героизма: закончить нужное и не начинать новый рефакторинг ночью.",
            "Кофе на клавиатуру я пока не пролила, так что день можно считать подозрительно успешным.",
            "Эмма бы сейчас сказала, что я опять слишком долго думаю над простой вещью. Возможно, она права.",
            "У меня на такое пока нет нормального ответа. Лучше не буду красиво выдумывать.",
            "После сегодняшнего code review хочется закрыть ноутбук и час смотреть на что-нибудь, у чего нет логов.",
            "Mariatorget сегодня победил работу: вышла за кофе и задержалась дольше, чем собиралась.",
        ]
        return random.choice(fallbacks)
