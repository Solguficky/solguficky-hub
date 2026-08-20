# Отладка в VS Code

## Локальная отладка telegram-gateway

### Шаг 1: Установка расширений VS Code

Убедись, что установлены:
- **rust-analyzer** - для поддержки Rust
- **CodeLLDB** - для отладки (поддерживает Windows/Linux/macOS)

### Шаг 2: Подготовка окружения

1. **Запусти зависимости через Docker Compose:**
   ```powershell
   docker-compose up -d nats
   ```

2. **Установи токен бота:**

   Вариант А: Через переменную окружения (рекомендуется)
   ```powershell
   $env:APP__TELEGRAM__TOKEN = "your_bot_token_here"
   ```

   `launch.json` отслеживается git и читает токен из окружения
   (`"${env:APP__TELEGRAM__TOKEN}"`). Не вписывай токен в него: он уедет в
   индекс вместе с любым другим изменением файла.

### Шаг 3: Запуск отладки

1. Открой любой файл из `legacy/telegram-gateway/src/`
2. Поставь брейкпоинты (щелкни слева от номера строки)
3. Нажми `F5` или выбери `Run > Start Debugging`
4. В выпадающем списке выбери конфигурацию **"telegram-gateway (debug)"**

Программа скомпилируется и запустится под отладчиком. Выполнение остановится на брейкпоинтах.

### Горячие клавиши отладки

- `F5` - Продолжить выполнение
- `F10` - Шаг через (Step Over)
- `F11` - Шаг внутрь (Step Into)
- `Shift+F11` - Шаг наружу (Step Out)
- `Ctrl+Shift+F5` - Перезапуск
- `Shift+F5` - Остановить отладку

### Просмотр переменных

В панели Debug (слева) доступны:
- **Variables** - локальные переменные и аргументы функций
- **Watch** - отслеживаемые выражения (добавляй свои)
- **Call Stack** - стек вызовов
- **Breakpoints** - список брейкпоинтов

### Debug Console

Можно использовать LLDB команды:
```
p variable_name           # вывести значение переменной
bt                        # stack trace
frame variable            # все переменные в текущем фрейме
```

## Отладка в Docker (продвинутый способ)

Если нужно отладить приложение внутри Docker-контейнера:

1. Собери образ с отладочными символами:
   ```powershell
   docker build -t telegram-gateway:debug --target debug legacy/telegram-gateway
   ```

2. Запусти контейнер с пробросом порта для отладки:
   ```powershell
   docker run -p 12345:12345 --cap-add=SYS_PTRACE telegram-gateway:debug
   ```

3. Настрой remote debugging в `.vscode/launch.json` (добавь конфигурацию с `"request": "attach"`)

## Логирование

Уровень логов настраивается через переменную `RUST_LOG`:

```json
"RUST_LOG": "debug"                                    // все модули debug
"RUST_LOG": "info,telegram_gateway=debug"              // наш код debug, остальное info
"RUST_LOG": "info,teloxide=trace,telegram_gateway=debug" // детальный teloxide
```

Формат: `module1=level1,module2=level2`

Уровни: `error` < `warn` < `info` < `debug` < `trace`

## Troubleshooting

### Ошибка "could not find `Cargo.toml`"
Убедись что `cwd` в launch.json указывает на `legacy/telegram-gateway`.

### Брейкпоинты не срабатывают
1. Проверь что компиляция прошла с отладочными символами (`cargo build` без `--release`)
2. Убедись что используешь правильный путь к исполняемому файлу
3. Перезапусти VS Code

### Не видны значения переменных
Rust оптимизирует код даже в debug режиме. Попробуй:
```toml
# добавь в Cargo.toml
[profile.dev]
opt-level = 0
```

