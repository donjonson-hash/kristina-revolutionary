from .router import router
from .base_agent import BaseAgent, AgentResponse

# Lazy imports — агенты загружаются только при явном обращении
def __getattr__(name):
    import importlib
    lazy_agents = {
        "KristinaPersonaAgent": "kristina_persona",
        "KristinaAdvisorAgent": "kristina_advisor",
        "KristinaCreativeAgent": "kristina_creative",
        "TrendScoutAgent": "trend_scout",
    }
    if name in lazy_agents:
        module = importlib.import_module(f".{lazy_agents[name]}", __package__)
        return getattr(module, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

__all__ = ['router', 'BaseAgent', 'AgentResponse',
           'KristinaPersonaAgent', 'KristinaAdvisorAgent', 'KristinaCreativeAgent',
           'TrendScoutAgent']
