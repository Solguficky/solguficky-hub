# 2026-11-20 — Git в харнессе исполнителя не пустил SSH-ключ, а рабочий обход нигде не описан

- **Контекст:** эпик [PER-917](https://linear.app/anticnvm/issue/per-917), лист [PER-906](https://linear.app/anticnvm/issue/per-906), исполнитель `opencode-go/glm-5.3` под Orca в дереве `per-906` на Windows. Шаг push контура ([agent-execution-loop.md](../agent-execution-loop.md)). Проверка готовности — [ready.sh](../../../tools/agent-env/ready.sh): перед раздачей `just agent-ready opencode` вернул 3 со строкой «not checked: component tooling (just tools), push rights, Linear write access».
- **Наблюдение:** по отчёту исполнителя git отверг SSH-ключ из-за прав, а Git Credential Manager без интерфейса зависал. Push прошёл через `git -c credential.helper= -c credential.helper='!gh auth git-credential'`. В документах среды этого обхода нет, исполнитель подобрал его сам. Исполнитель предложил записать это наблюдение кандидатом рефлексии.
- **Последствие:** шаг push стоил исполнителю подбора транспорта. Другой исполнитель на той же машине начнёт подбор заново. Проверка готовности права push не проверяет и называет их «not checked», поэтому до работы сбой не виден.
- **Адресат:** Автоматическая проверка — `tools/agent-env/ready.sh`: read-only проба `git ls-remote origin` теми же учётными данными, что у push, и рабочий транспорт поимённо в выводе.
- **Повторение:** первое наблюдение. Запись [о push из WSL](2026-10-05-ops-push-from-wsl-without-credentials.md) о другой среде и другом репозитории: там в WSL не было учётных данных вовсе.
- **Следующий сигнал:** в другой задаче push из харнесса падает на SSH-ключе или виснет на Git Credential Manager, а `just agent-ready` перед работой этого не назвал.
- **Статус:** наблюдение
