# creative_sandbox.py — Creative Sandbox Mode for Kristina
import random
import asyncio
import json
import logging
from datetime import datetime
from typing import List, Dict, Any, Optional
from dataclasses import dataclass, field
from enum import Enum

logger = logging.getLogger(__name__)

class TaskOrigin(Enum):
    USER_REQUEST = "user_request"
    SELF_GENERATED = "self_generated"
    TRIGGERED_BY_CONTEXT = "context_triggered"

@dataclass
class CreativeTask:
    id: str = field(default_factory=lambda: f"task_{datetime.now().strftime('%Y%m%d_%H%M%S')}")
    origin: TaskOrigin = TaskOrigin.SELF_GENERATED
    seed: str = ""
    domain: str = ""
    context: Dict = field(default_factory=dict)
    status: str = "ideation"
    research: Optional[str] = None
    concepts: List[Dict] = field(default_factory=list)
    selected_concept: Optional[Dict] = None
    deliverable: Optional[Any] = None
    reflection: Optional[str] = None
    created_at: datetime = field(default_factory=datetime.now)
    completed_at: Optional[datetime] = None
    
    def to_dict(self) -> Dict:
        return {
            'id': self.id,
            'origin': self.origin.value,
            'seed': self.seed,
            'domain': self.domain,
            'status': self.status,
            'created_at': self.created_at.isoformat()
        }

class CreativeSandbox:
    CREATIVE_SEEDS = [
        "придумать необычный формат контента для",
        "изучить тренд и предложить применение в",
        "создать концепт продукта для аудитории",
        "проанализировать проблему и предложить UX-решение для",
        "сгенерировать визуальную серию на тему",
        "написать эссе/манифест о",
        "спроектировать интерфейс для",
        "предложить редизайн классического элемента в",
    ]
    
    DOMAINS = [
        "мобильных приложений",
        "социальных сетей",
        "скандинавского дизайна",
        "городской жизни Стокгольма",
        "психологии поколения Z",
        "AI в повседневности",
        "цифрового минимализма",
        "устойчивого развития",
        "удалённой работы",
        "ментального здоровья",
    ]
    
    def __init__(self, brain=None, memory=None, self_learning=None, llm_client=None):
        self.brain = brain
        self.memory = memory
        self.learner = self_learning
        self.llm = llm_client
        self.active_tasks: List[CreativeTask] = []
        
    async def generate_creative_task(self, trigger: Optional[str] = None) -> CreativeTask:
        if trigger:
            seed = f"развить идею: {trigger}"
            domain = await self._infer_domain(trigger)
        else:
            seed = random.choice(self.CREATIVE_SEEDS)
            domain = random.choice(self.DOMAINS)
        
        context = await self._get_personal_context()
        
        task = CreativeTask(
            origin=TaskOrigin.SELF_GENERATED,
            seed=seed,
            domain=domain,
            context=context
        )
        
        logger.info(f"🎨 Generated task: {seed} {domain}")
        return task
    
    async def execute_full_cycle(self, task: CreativeTask) -> CreativeTask:
        try:
            task.status = "research"
            task.research = await self._conduct_research(task)
            logger.info(f"🔍 Research completed for {task.id}")
            
            task.status = "concept"
            task.concepts = await self._generate_concepts(task)
            logger.info(f"💡 Generated {len(task.concepts)} concepts")
            
            task.selected_concept = await self._self_select(task.concepts)
            logger.info(f"✅ Selected concept: {task.selected_concept.get('title', 'Untitled')}")
            
            task.status = "execution"
            task.deliverable = await self._create_deliverable(task)
            
            task.status = "reflection"
            task.reflection = await self._self_reflect(task)
            
            task.status = "done"
            task.completed_at = datetime.now()
            
            await self._save_experience(task)
            
            return task
            
        except Exception as e:
            logger.error(f"❌ Creative cycle failed: {e}")
            task.status = "failed"
            return task
    
    async def _conduct_research(self, task: CreativeTask) -> str:
        if self.learner:
            research = await self.learner.research_topic(
                f"{task.seed} {task.domain}",
                depth="creative"
            )
            return research
        return f"Исследование {task.domain}: ключевые тренды и инсайты"
    
    async def _generate_concepts(self, task: CreativeTask) -> List[Dict]:
        concepts = []
        angles = ["radical", "pragmatic", "playful"]
        
        for angle in angles:
            concept = await self._generate_single_concept(task, angle)
            concepts.append(concept)
        
        return concepts
    
    async def _generate_single_concept(self, task: CreativeTask, angle: str) -> Dict:
        prompt = f"""Ты Кристина, UX-дизайнер из Стокгольма. {task.seed} {task.domain}.
Контекст: {task.context.get('recent_mood', 'творческий настрой')}
Угол подхода: {angle}
Создай концепт в JSON:
{{"title": "Название", "hook": "Хук", "description": "Описание", "rationale": "Обоснование", "visual_prompt": "Для картинки"}}"""
        
        if self.llm:
            try:
                response = await self.llm.generate(prompt)
                return self._parse_concept(response)
            except Exception as e:
                logger.error(f"LLM failed: {e}")
        
        return {
            "title": f"Концепт {angle}",
            "hook": "Интересное решение",
            "description": "Описание",
            "rationale": "Обоснование",
            "visual_prompt": f"Minimalist design, {task.domain}",
            "angle": angle
        }
    
    async def _self_select(self, concepts: List[Dict]) -> Dict:
        scores = []
        for c in concepts:
            score = 0
            if any(w in c['title'].lower() for w in ['скандинавский', 'стокгольм', 'минимализм']):
                score += 3
            if c.get('angle') == 'radical':
                score += 2
            scores.append(score)
        
        best_idx = scores.index(max(scores))
        return concepts[best_idx]
    
    async def _create_deliverable(self, task: CreativeTask) -> Dict:
        concept = task.selected_concept
        return {
            'type': 'concept_document',
            'title': concept['title'],
            'content': {
                'hook': concept['hook'],
                'research_insights': task.research[:500] if task.research else "На основе опыта",
                'concept_description': concept['description'],
                'rationale': concept['rationale'],
                'visual_concept': concept['visual_prompt'],
                'next_steps': "Можно развить дальше"
            },
            'metadata': {
                'task_id': task.id,
                'domain': task.domain
            }
        }
    
    async def _self_reflect(self, task: CreativeTask) -> str:
        return f"Рефлексия: задача {task.id} выполнена. Выбран концепт '{task.selected_concept.get('title')}'."
    
    async def _get_personal_context(self) -> Dict:
        return {
            'recent_mood': 'творческий подъём',
            'location': 'Стокгольм',
            'workload': 'средняя'
        }
    
    async def _infer_domain(self, trigger: str) -> str:
        keywords = {
            'приложение': 'мобильных приложений',
            'дизайн': 'скандинавского дизайна',
            'соцсеть': 'социальных сетей',
        }
        for word, domain in keywords.items():
            if word in trigger.lower():
                return domain
        return random.choice(self.DOMAINS)
    
    def _parse_concept(self, response: str) -> Dict:
        try:
            start = response.find('{')
            end = response.rfind('}') + 1
            if start != -1:
                return json.loads(response[start:end])
        except:
            pass
        return {'title': 'Концепт', 'hook': 'Хук', 'description': response[:200], 'rationale': 'OK', 'visual_prompt': 'Design'}
    
    async def _save_experience(self, task: CreativeTask):
        if self.memory:
            await self.memory.save({
                'type': 'creative_experience',
                'task': task.to_dict(),
                'reflection': task.reflection
            })


async def run_sandbox_cycle(sandbox: CreativeSandbox, announce: bool = False):
    task = await sandbox.generate_creative_task()
    if announce:
        logger.info(f"💭 Думаю о {task.domain}...")
    completed = await sandbox.execute_full_cycle(task)
    if completed.status == "done":
        return completed.deliverable
    return None
