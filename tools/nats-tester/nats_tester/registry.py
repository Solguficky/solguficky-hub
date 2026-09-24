"""Реестр subjects: subject -> сгенерированный класс сообщения.

Запись добавляется вместе с принятием контракта — одновременно с
`docs/architecture/integration.md` и `NATS_PROTO_FILES` в `proto_sources.py`.

Схемы `identity/v1/identity_service.proto`, `meetups/v1/meetups_service.proto`,
`notifications/v1/notifications_service.proto` и `auction/v1/auction_service.proto`
обслуживают gRPC и в реестр не попадают: subject у них не бывает. Классы
`meetups/v1/meetups.proto`, `identity/v1/roles.proto` и `auction/v1/auction.proto`
собираются как payload: их импортируют схемы событий своих доменов, и без них
те не импортируются.

У Meetups, Identity и Auction subject называет повод, а сообщение на всех поводах
домена одно: повод живёт и в ветке `oneof` тоже, поэтому потребитель на
`events.meetups.>` или `events.identity.>` разбирает ветку, а не строку
subject'а. Имя subject'а — префикс домена плюс имя ветки `oneof occasion`, и
это соответствие проверяет `gate.subject_problems()`: до него оно держалось
на слове в этом комментарии.
"""

from typing import Type

from google.protobuf.message import Message

from nats_tester.generated.auction.v1 import auction_events_pb2
from nats_tester.generated.identity.v1 import identity_events_pb2
from nats_tester.generated.meetups.v1 import meetups_events_pb2
from nats_tester.generated.notifications.v1 import notifications_pb2

EVENT_TYPES: dict[str, Type[Message]] = {
    'events.notifications.notification_created': notifications_pb2.Notification,
    'events.identity.profile_registered': identity_events_pb2.IdentityEvent,
    'events.identity.role_granted': identity_events_pb2.IdentityEvent,
    'events.identity.role_revoked': identity_events_pb2.IdentityEvent,
    'events.identity.profile_blocked': identity_events_pb2.IdentityEvent,
    'events.identity.profile_unblocked': identity_events_pb2.IdentityEvent,
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
    'events.auction.lot_opened': auction_events_pb2.LotEvent,
    'events.auction.bid_placed': auction_events_pb2.LotEvent,
    'events.auction.ask_advanced': auction_events_pb2.LotEvent,
    'events.auction.deadline_extended': auction_events_pb2.LotEvent,
    'events.auction.lot_sold': auction_events_pb2.LotEvent,
    'events.auction.lot_unsold': auction_events_pb2.LotEvent,
    'events.auction.lot_withdrawn': auction_events_pb2.LotEvent,
    'events.auction.lot_held_for_final': auction_events_pb2.LotEvent,
    'events.auction.lot_resumed': auction_events_pb2.LotEvent,
}

COMMAND_TYPES: dict[str, Type[Message]] = {}

ALL_MESSAGE_TYPES = {**EVENT_TYPES, **COMMAND_TYPES}
