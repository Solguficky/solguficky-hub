"""Реестр subjects: subject -> сгенерированный класс сообщения.

Запись добавляется вместе с принятием контракта — одновременно с
`docs/architecture/integration.md` и `NATS_PROTO_FILES` в `proto_sources.py`.

Схемы identity/v1, meetups/v1/meetups_service.proto и
notifications/v1/notifications_service.proto обслуживают gRPC и в реестр не
попадают: subject у них не бывает. Классы `meetups/v1/meetups.proto`
собираются как payload: их импортирует схема событий Meetups, и без них она
не импортируется.

У Meetups subject называет повод, а сообщение на всех поводах одно: повод
живёт и в ветке `oneof` тоже, поэтому потребитель на `events.meetups.>`
разбирает ветку, а не строку subject'а. Имя subject'а — `events.meetups.`
плюс то же значение, которое уходит в колонку `event_type` журнала;
соответствие держит тест контрактной поверхности Meetups, а не этот список.
"""

from typing import Type

from google.protobuf.message import Message

from nats_tester.generated.meetups.v1 import meetups_events_pb2
from nats_tester.generated.notifications.v1 import notifications_pb2

EVENT_TYPES: dict[str, Type[Message]] = {
    'events.notifications.notification_created': notifications_pb2.Notification,
    'events.meetups.meetup_created': meetups_events_pb2.MeetupEvent,
    'events.meetups.meetup_changed': meetups_events_pb2.MeetupEvent,
    'events.meetups.meetup_published': meetups_events_pb2.MeetupEvent,
    'events.meetups.meetup_unpublished': meetups_events_pb2.MeetupEvent,
    'events.meetups.meetup_republished': meetups_events_pb2.MeetupEvent,
    'events.meetups.meetup_publication_scheduled': meetups_events_pb2.MeetupEvent,
    'events.meetups.meetup_publication_cancelled': meetups_events_pb2.MeetupEvent,
    'events.meetups.meetup_cancelled': meetups_events_pb2.MeetupEvent,
    'events.meetups.meetup_material_attached': meetups_events_pb2.MeetupEvent,
    'events.meetups.meetup_material_removed': meetups_events_pb2.MeetupEvent,
    'events.meetups.meetup_held': meetups_events_pb2.MeetupEvent,
}

COMMAND_TYPES: dict[str, Type[Message]] = {}

ALL_MESSAGE_TYPES = {**EVENT_TYPES, **COMMAND_TYPES}
