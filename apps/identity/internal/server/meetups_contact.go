package server

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	meetupsv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/meetups/v1"
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	metricnoop "go.opentelemetry.io/otel/metric/noop"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// Переменные клиента Meetups. Префикс сервиса, как у IDENTITY_NATS_URL.
const (
	MeetupsURLEnv     = "IDENTITY_MEETUPS_GRPC_URL"
	ServiceTokenEnv   = "IDENTITY_SERVICE_TOKEN"
	meetupsDeadline   = 3 * time.Second
	meetupsAuthHeader = "authorization"
)

// ErrContactUnavailable — Meetups не смог ответить: недоступен, не уложился в
// срок или ответил отказом, который не говорит про человека. Метод читает его
// как UNAVAILABLE, а не как «ника нет».
var ErrContactUnavailable = errors.New("meetups contact confirmation unavailable")

// ContactConfirmer — вопрос Identity к Meetups перед ником в карточке
// (ADR-076, п. 10): автор ли человек сходки или организатор из её состава, и
// видит ли смотрящий эту сходку. Ответ — только «подтверждено» или «нет»;
// «нет» одно для отсутствующей, скрытой и чужой сходки. Ошибка — не «нет».
type ContactConfirmer interface {
	ConfirmContact(ctx context.Context, meetupID, viewerID, identityID string) (confirmed bool, err error)
}

// MeetupsClient — клиент `MeetupsService.ConfirmMeetupContact` со своим токеном
// и сроком, без повторов: по образцу клиента Meetups → Identity. Срок больше
// двух секунд вложенного `CheckAccessRight` из Meetups; вторую попытку за
// вызывающего не делаем — ответ ждёт карточка, и она переживает отказ без ника.
type MeetupsClient struct {
	client   meetupsv1.MeetupsServiceClient
	token    string
	deadline time.Duration
}

// NewMeetupsClient собирает клиента поверх готового соединения.
func NewMeetupsClient(conn grpc.ClientConnInterface, token string) *MeetupsClient {
	return &MeetupsClient{client: meetupsv1.NewMeetupsServiceClient(conn), token: token, deadline: meetupsDeadline}
}

// DialMeetups открывает ленивое соединение: процесс поднимается при
// недоступном Meetups, а отказ приходит ответом на запрос. Схема http:// — h2c,
// как у остальных сервисов графа; адрес может быть и просто host:port.
func DialMeetups(rawURL, token string, tp trace.TracerProvider) (*MeetupsClient, *grpc.ClientConn, error) {
	target, err := meetupsTarget(rawURL)
	if err != nil {
		return nil, nil, err
	}
	if strings.TrimSpace(token) == "" {
		return nil, nil, fmt.Errorf("%s is not set", ServiceTokenEnv)
	}
	conn, err := grpc.NewClient(target,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithStatsHandler(otelgrpc.NewClientHandler(
			otelgrpc.WithTracerProvider(tp),
			otelgrpc.WithPropagators(propagation.TraceContext{}),
			otelgrpc.WithMeterProvider(metricnoop.NewMeterProvider()),
		)),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("dial meetups: %w", err)
	}
	return NewMeetupsClient(conn, strings.TrimSpace(token)), conn, nil
}

func meetupsTarget(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("%s is empty", MeetupsURLEnv)
	}
	if !strings.Contains(raw, "://") {
		return raw, nil
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return "", fmt.Errorf("%s is not a URL with a host", MeetupsURLEnv)
	}
	return parsed.Host, nil
}

// ConfirmContact отвечает true на OK, false на NOT_FOUND и ErrContactUnavailable
// на всё остальное: INVALID_ARGUMENT и UNAUTHENTICATED — дефект одной из сторон,
// и «ника нет» он не означает.
func (c *MeetupsClient) ConfirmContact(ctx context.Context, meetupID, viewerID, identityID string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, c.deadline)
	defer cancel()
	_, err := c.client.ConfirmMeetupContact(c.withHeaders(ctx), &meetupsv1.ConfirmMeetupContactRequest{
		Id: meetupID, ViewerIdentityId: viewerID, IdentityId: identityID,
	})
	switch status.Code(err) {
	case codes.OK:
		return true, nil
	case codes.NotFound:
		return false, nil
	default:
		return false, fmt.Errorf("%w: %s", ErrContactUnavailable, status.Code(err))
	}
}

// withHeaders подписывает вызов токеном Identity и несёт заголовки цепочки
// входящего вызова; пустые не отправляются.
func (c *MeetupsClient) withHeaders(ctx context.Context) context.Context {
	pairs := []string{meetupsAuthHeader, "Bearer " + c.token}
	if id := requestID(ctx); id != "" {
		pairs = append(pairs, "x-request-id", id)
	}
	if useCase := incomingMetadata(ctx, "x-use-case"); useCase != "" {
		pairs = append(pairs, "x-use-case", useCase)
	}
	return metadata.AppendToOutgoingContext(ctx, pairs...)
}
