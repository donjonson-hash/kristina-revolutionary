# Compare These Texts переехал

Разработка, issues, сборки и проверки проекта теперь находятся в отдельном
репозитории: **[donjonson-hash/compare-these-texts](https://github.com/donjonson-hash/compare-these-texts)**.

Сайт: https://comparethesetexts.com/.

## Перенос

- Перенесена версия **0.35.0**: сайт, расширение Chrome, LibreOffice Writer и Google Docs.
- Исходная точка: коммит `7ec380657bf61f9c153e6139722ae77df4095480` этого репозитория, каталог `ctt/`.
- История изменений каталога сохранена в новом репозитории; хеши переписаны при переносе файлов в корень.
- Первый самостоятельный коммит: [`8e10d0f`](https://github.com/donjonson-hash/compare-these-texts/commit/8e10d0f59590262fae0be624871cdc6f883e01d3).
- Все три проверки GitHub Actions в новом репозитории прошли: CTT, CTT Writer и CTT Google Docs.

Здесь оставлена только эта заметка. Прежние исходники доступны в истории Git.
Изменения CTT и новые отчёты об ошибках направляйте в новый репозиторий.
Подробности: [MIGRATION.md](https://github.com/donjonson-hash/compare-these-texts/blob/main/MIGRATION.md).

Историческое расширение 0.18.1 в `../extension/` и его проверки остаются отдельным
компонентом этого репозитория. Перенос исходников сам по себе не публикует
новую версию сайта или расширения в Chrome Web Store.
