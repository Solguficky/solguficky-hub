# 2026-11-22 — OpenCode под Orca трижды не стартовал, хотя из оболочки дерева модель отвечала

- **Контекст:** эпик [PER-908](https://linear.app/anticnvm/issue/per-908), лист [PER-923](https://linear.app/anticnvm/issue/per-923), Orca 1.4.266, Run `run_c222d9c370b6`, Task `task_adfbc46d06e8`. Старт — `worker-start --agent opencode --model opencode-go/<модель>` по шагу 5 [proj-run-epic](../../../.skillshare/skills/proj/proj-run-epic/SKILL.md).
- **Наблюдение:** Orca трижды вернула эскалацию `failureKind=startFailed` с `{"errorName":"ServiceUnavailableError"}` и текстом «OpenCode couldn't start. Send your message to try again»:
  - на `opencode-go/hy4-flash-free` (dispatch `ctx_e228f7e305fb`);
  - на повторе через `reply` в тот же чат;
  - на `opencode-go/deepseek-v4.1-flash` (`ctx_42e58126dafc`).

  `worker-show` показывал `state=start_unknown`, `liveness=exited`. Тем временем `opencode run --model opencode-go/deepseek-v4.1-flash "Reply with the single word OK"` из оболочки того же дерева ответил `OK` с EXIT=0: пул и модель были живы, не поднимался запуск OpenCode под Orca. Ещё одна попытка через `reply` тоже не дала хода. Лист ушёл на Codex и через три часа вернулся на OpenCode: тот же `worker-start` на deepseek стартовал штатно, и с ним стартовали ещё четыре листа эпика. Сам повтор `worker-start --task … --retry-of <dispatch>` Orca отклоняла `task_not_startable`, пока упавший dispatch числился `pending`. Принимала только после `worker-stop` этого dispatch.
- **Последствие:** лист стоял около трёх часов. Ушли два вопроса владельцу (Q-6, Q-8) и перенос на Codex, который потом упёрся в лимит. Совет Orca «Send your message to try again» не помог ни разу. Без пробы `opencode run` нельзя было отличить сбой пула от сбоя запуска под Orca и выбрать, что переносить.
- **Адресат:** Скилл — шаг 6 [proj-run-epic](../../../.skillshare/skills/proj/proj-run-epic/SKILL.md), эскалация со `startFailed`. Порядок такой:
  1. Одна проба `opencode run` той же модели из дерева листа.
  2. Пул жив — перенос на другой харнесс по порядку владельца, а не повтор `reply`.
  3. Перед `--retry-of` — `worker-stop` упавшего dispatch.

  Автоматическая проверка не подходит: сбой в рантайме Orca, а не в репозитории.
- **Повторение:** первое наблюдение. Родственная запись [о молчаливом выходе после лимита](2026-11-19-worker-exited-after-limit-unreported.md): там сбой прятал `start_unknown` без эскалации, здесь эскалация была, но её совет не работал.
- **Следующий сигнал:** в другом эпике `worker-start` OpenCode под Orca даёт `startFailed` с `ServiceUnavailableError`, а `opencode run` той же модели из дерева отвечает.
- **Статус:** наблюдение
