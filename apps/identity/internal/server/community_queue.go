package server

import "fmt"

// CommunityQueueEnv — переменная среды режима очереди сообщества.
const CommunityQueueEnv = "IDENTITY_COMMUNITY_QUEUE"

// CommunityQueue — принимает ли очередь сообщества заявки (ADR-060, дополнение
// 2026-10-25). Закрытая очередь пускает в хаб только по белому списку:
// RequestAccess без записи отвечает INVITATION_ONLY и заявки не ставит.
// Нулевое значение — открытая очередь, прежнее поведение. Очередь аукциона не
// закрывается.
type CommunityQueue int

const (
	CommunityQueueOpen CommunityQueue = iota
	CommunityQueueClosed
)

// ParseCommunityQueue читает значение переменной: пусто или `open` — открыта,
// `closed` — закрыта. Иное значение — ошибка, и процесс не стартует: опечатка в
// values среды не должна молча оставить очередь открытой.
func ParseCommunityQueue(raw string) (CommunityQueue, error) {
	switch raw {
	case "", "open":
		return CommunityQueueOpen, nil
	case "closed":
		return CommunityQueueClosed, nil
	default:
		return CommunityQueueOpen, fmt.Errorf("%s must be open or closed", CommunityQueueEnv)
	}
}

func (q CommunityQueue) String() string {
	if q == CommunityQueueClosed {
		return "closed"
	}
	return "open"
}

// WithCommunityQueue задаёт режим очереди сообщества. Без опции очередь открыта.
func WithCommunityQueue(q CommunityQueue) Option {
	return func(c *config) { c.communityQueue = q }
}
