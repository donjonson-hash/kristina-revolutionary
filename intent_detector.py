"""
Распознавание намерений пользователя без команд
"""
import re

def detect_proposal_intent(text: str) -> bool:
    """Определить хочет ли пользователь получить КП"""
    text_lower = text.lower()
    
    # Прямые согласия
    yes_patterns = [
        r'\bда[а]*\b', r'\bконечно\b', r'\bдавай\b', r'\bподготовь\b',
        r'\bсделай\b', r'\bхочу\b', r'\bинтересно\b', r'\bок\b',
        r'\bхорошо\b', r'\bсогласен\b', r'\bдавайте\b', r'\bго\b',
        r'\bпогнали\b', r'\bвпер[её]д\b', r'\bначинай\b', r'\bделай\b'
    ]
    
    # Упоминания КП/предложения
    proposal_patterns = [
        r'кп', r'коммерческое', r'предложение', r'смета', r'расч[её]т',
        r'цен[аы]', r'стоимость', r'бюджет', r'оценка', r'прайс',
        r'плат[иё]ж', r'оплат[аи]', r'договор', r'условия'
    ]
    
    # Проверяем согласие
    has_yes = any(re.search(p, text_lower) for p in yes_patterns)
    has_proposal = any(re.search(p, text_lower) for p in proposal_patterns)
    
    # Если явное согласие + контекст КП, или прямое "подготовь КП"
    if has_yes and has_proposal:
        return True
    
    # Контекстные фразы
    context_patterns = [
        r'подготовь.*кп', r'сделай.*предложение', r'вышли.*смету',
        r'рассчитай.*стоимость', r'сколько.*будет.*стоить',
        r'напиши.*предложение', r'оформи.*кп', r'составь.*смету'
    ]
    
    return any(re.search(p, text_lower) for p in context_patterns)

def detect_meeting_intent(text: str) -> bool:
    """Определить хочет ли пользователь встречу/звонок"""
    text_lower = text.lower()
    
    meeting_patterns = [
        r'\bвстреч[аи]\b', r'\bзвонок\b', r'\bпозвон[иь]\b',
        r'\bобсудим\b', r'\bпоговорим\b', r'\bвстретимся\b',
        r'\bкогда.*свободн', r'\bвремя\b', r'\bдата\b',
        r'\bкалендарь\b', r'\bзапланиру[емй]\b', r'\bzoom\b',
        r'\bteams\b', r'\bскайп\b', r'\bдискуссия\b'
    ]
    
    return any(re.search(p, text_lower) for p in meeting_patterns)
