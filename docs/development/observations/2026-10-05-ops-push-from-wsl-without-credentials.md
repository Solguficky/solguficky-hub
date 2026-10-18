# 2026-10-05 — Push ops-репозитория из WSL не проходил ни у агента, ни у владельца

- **Контекст:** PER-371, [PR #363](https://github.com/Solguficky/solguficky-hub/pull/363). Приватный `Solguficky/solguficky-ops` склонирован в домашний каталог WSL (`~/solguficky-ops`), remote по HTTPS.
- **Наблюдение:** агент и владелец по отдельности запускали `git push origin main` из WSL. Оба раза: `fatal: unable to get password from user`. В WSL не нашлось ни credential helper (`credential.helper` пуст), ни `gh`, ни SSH-ключа GitHub: в `~/.ssh` лежит только ключ хоста. GitHub пароль аккаунта для push не принимает. Владелец не понимал, что от него нужно. Сработал Windows-git, у которого учётные данные есть, по UNC-пути: `git -c safe.directory='*' -C //wsl.localhost/Ubuntu/home/anticnvm/solguficky-ops push origin main`.
- **Последствие:** коммиты ops-репозитория лежали только локально до самой сдачи, и PR пришлось бы открывать со ссылкой на неопубликованные хэши. Ушёл один круг к владельцу, который сам упёрся в ту же ошибку.
- **Адресат:** README ops-репозитория, раздел «Control node»: control node в WSL получает учётные данные GitHub (`gh auth login` и `gh auth setup-git`) либо remote по SSH. Это его правило, а не правило этого репозитория. Если владелец оставит push через Windows-git, адресат — память агента: форма вызова с `safe.directory`. Автоматическая проверка не подходит: учётные данные живут на машине, а не в репозитории.
- **Повторение:** первое наблюдение. Записи журнала о push касаются порядка операций и кода возврата, а не учётных данных.
- **Следующий сигнал:** push из WSL в любой репозиторий снова падает на `unable to get password from user` или на запросе пароля.
- **Статус:** наблюдение
