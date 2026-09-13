"""Execute a bounded repository follow-up before composing the conversational reply."""

from ai_client import get_ai_client
from repository_evidence import evidence_text
from repository_research import RepositoryReader, search_paths
from research_planner import _selection


async def inspect_followup(target, request, history, *, reader=None):
    """At most two model decisions, one tree search and four read-only files.

    The target is supplied by the router from this session's user messages, never
    from model output. A repository-wide search retains the resolved commit.
    There is no deferred action hidden behind a conversational promise.
    """
    reader = reader or RepositoryReader()
    client = get_ai_client()
    try:
        choice = await _selection(client,
            'Реши, нужно ли сейчас прочитать GitHub для ответа. '
            'Верни {"decision":"skip"} для бытового разговора, статуса эксперимента или отказа. '
            'Если пользователь просит прочитать/найти код, проверить утверждение по файлу, '
            'или соглашается на предложенное в предыдущей реплике чтение, выполни его сейчас: '
            '{"decision":"inspect","scope":"target","query":"..."}. '
            'query — до 300 символов: имена полей, файлов, функций или ключевые слова поиска. '
            'scope=target сохраняет выбранный файл/папку. scope=repository допустим только '
            'для просьбы найти/прочитать другие файлы того же репозитория. '
            'Не переключай репозиторий и не обещай действия в будущем. Прошлые реплики assistant '
            'помогают понять согласие, но не доказывают чтение или выполнение. '
            'Запуск эксперимента — отдельный фоновый цикл; эта операция только читает файлы.',
            {'target': target, 'request': request[:12000],
             'history': [{'role': m.get('role'), 'content': m.get('content', '')[:1500]}
                         for m in history[-6:]]}, 400)
        if choice == {'decision': 'skip'}:
            return None
        if (set(choice) != {'decision', 'scope', 'query'} or choice['decision'] != 'inspect'
                or choice['scope'] not in ('target', 'repository')
                or not isinstance(choice['query'], str) or len(choice['query']) > 300):
            raise ValueError('Invalid repository action')
        snapshot = await reader.snapshot(target)
        if choice['scope'] == 'repository' and snapshot['scope_path']:
            snapshot = await reader.snapshot(
                f"https://github.com/{snapshot['repository']}/tree/{snapshot['commit']}")
        paths = search_paths(snapshot, choice['query'])
        if snapshot['scope_kind'] == 'blob':
            selected = paths
        elif not paths:
            selected = []
        else:
            selection = await _selection(client,
                'Выбери файлы для текущего запроса из available_paths: '
                '{"paths":["точный/путь"]}. Не более четырёх. '
                'Если нужны только пути или подходящих файлов не видно, верни {"paths":[]}. '
                'Чтобы сказать, как устроена валидация, прочитай код и тесты, а не только схему. '
                'Поиск ограничен именами файлов; отсутствие пути в списке не доказывает отсутствие кода.',
                {'request': request[:12000], 'query': choice['query'],
                 'available_paths': paths, 'commit': snapshot['commit']}, 500)
            if (set(selection) != {'paths'} or not isinstance(selection['paths'], list)
                    or len(selection['paths']) > 4
                    or any(not isinstance(p, str) or p not in paths for p in selection['paths'])
                    or len(set(selection['paths'])) != len(selection['paths'])):
                raise ValueError('Invalid repository file selection')
            selected = selection['paths']
        sources = await reader.read_files(snapshot, selected) if selected else []
        return evidence_text(snapshot, sources, paths, choice['query'])
    finally:
        await client.close()
