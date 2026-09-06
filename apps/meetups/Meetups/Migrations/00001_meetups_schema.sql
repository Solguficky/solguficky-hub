CREATE TABLE meetups (
    id UUID PRIMARY KEY,
    author UUID NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    venue TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT '',
    calendar_link TEXT NOT NULL DEFAULT '',
    lifecycle TEXT NOT NULL,
    visibility TEXT NOT NULL,
    first_published_at TIMESTAMPTZ,
    scheduled_publish_at TIMESTAMPTZ,
    version INTEGER NOT NULL,
    schedule_form TEXT NOT NULL,
    schedule_precision TEXT,
    schedule_start_date DATE,
    schedule_start_time TIME,
    schedule_end_date DATE,
    schedule_end_time TIME,
    CONSTRAINT meetups_lifecycle_check
        CHECK (lifecycle IN ('planned', 'held', 'cancelled')),
    CONSTRAINT meetups_visibility_check
        CHECK (visibility IN ('hidden', 'visible')),
    CONSTRAINT meetups_version_positive
        CHECK (version >= 1),
    CONSTRAINT meetups_schedule_form_check
        CHECK (schedule_form IN ('no_date', 'tentative', 'fixed')),
    CONSTRAINT meetups_schedule_precision_check
        CHECK (
            schedule_precision IS NULL
            OR schedule_precision IN ('day', 'day_start', 'interval')
        ),
    CONSTRAINT meetups_schedule_shape_check
        CHECK (
            (
                schedule_form = 'no_date'
                AND schedule_precision IS NULL
                AND schedule_start_date IS NULL
                AND schedule_start_time IS NULL
                AND schedule_end_date IS NULL
                AND schedule_end_time IS NULL
            )
            OR (
                schedule_form IN ('tentative', 'fixed')
                AND schedule_precision = 'day'
                AND schedule_start_date IS NOT NULL
                AND schedule_start_time IS NULL
                AND schedule_end_date IS NULL
                AND schedule_end_time IS NULL
            )
            OR (
                schedule_form IN ('tentative', 'fixed')
                AND schedule_precision = 'day_start'
                AND schedule_start_date IS NOT NULL
                AND schedule_start_time IS NOT NULL
                AND schedule_end_date IS NULL
                AND schedule_end_time IS NULL
            )
            OR (
                schedule_form IN ('tentative', 'fixed')
                AND schedule_precision = 'interval'
                AND schedule_start_date IS NOT NULL
                AND schedule_start_time IS NOT NULL
                AND schedule_end_date IS NOT NULL
                AND schedule_end_time IS NOT NULL
                AND (schedule_end_date, schedule_end_time)
                    >= (schedule_start_date, schedule_start_time)
            )
        ),
    CONSTRAINT meetups_scheduled_publish_only_when_hidden
        CHECK (scheduled_publish_at IS NULL OR visibility = 'hidden')
);

CREATE INDEX meetups_visible_schedule
    ON meetups (schedule_start_date ASC NULLS LAST, schedule_start_time ASC NULLS LAST)
    WHERE visibility = 'visible';

CREATE INDEX meetups_due_publication
    ON meetups (scheduled_publish_at)
    WHERE scheduled_publish_at IS NOT NULL AND visibility = 'hidden';

CREATE TABLE meetup_events (
    event_id UUID PRIMARY KEY,
    meetup_id UUID NOT NULL REFERENCES meetups (id),
    version INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    performed_by UUID NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    position BIGINT GENERATED ALWAYS AS IDENTITY,
    CONSTRAINT meetup_events_version_positive
        CHECK (version >= 1),
    CONSTRAINT meetup_events_type_check
        CHECK (event_type IN ('meetup_created', 'meetup_changed', 'meetup_published')),
    CONSTRAINT meetup_events_payload_object
        CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT meetup_events_meetup_version_key
        UNIQUE (meetup_id, version),
    CONSTRAINT meetup_events_position_key
        UNIQUE (position)
);
