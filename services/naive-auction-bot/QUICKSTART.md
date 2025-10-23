# Быстрый старт

## Локально

```bash
cd services/naive-auction-bot
pip install -r requirements.txt
cp .env.example .env
# Отредактируйте .env и добавьте TG_BOT_TOKEN
python bot.py
```

## Railway

1. Создайте новый проект на [Railway.app](https://railway.app)
2. Подключите GitHub репозиторий
3. Настройте Root Directory: `services/naive-auction-bot`
4. Добавьте переменные окружения:
   - `TG_BOT_TOKEN` = ваш токен от @BotFather
   - `CREATOR_ID` = ваш Telegram User ID (опционально)
5. (Опционально) Добавьте Volume с Mount Path `/app` для персистентности БД
6. Deploy!

## Получение Telegram Bot Token

1. Откройте [@BotFather](https://t.me/BotFather) в Telegram
2. Отправьте `/newbot`
3. Следуйте инструкциям
4. Скопируйте полученный токен

## Получение вашего Telegram User ID

1. Откройте [@userinfobot](https://t.me/userinfobot)
2. Отправьте `/start`
3. Скопируйте ваш ID

