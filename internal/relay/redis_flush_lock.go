package relay

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"

	"github.com/redis/go-redis/v9"
)

const flushLockPrefix = "collab:flush:"

// redisFlushLock implements FlushLock using Redis SETNX with TTL.
// Only the lock holder can release it (Lua script checks owner).
type redisFlushLock struct {
	client  redis.UniversalClient
	ownerID string
}

// NewRedisFlushLock creates a Redis-backed distributed flush lock.
func NewRedisFlushLock(client redis.UniversalClient) *redisFlushLock {
	id := make([]byte, 8)
	rand.Read(id)
	return &redisFlushLock{
		client:  client,
		ownerID: hex.EncodeToString(id),
	}
}

func (l *redisFlushLock) Acquire(ctx context.Context, documentID string, ttl time.Duration) (bool, error) {
	key := flushLockPrefix + documentID
	ok, err := l.client.SetNX(ctx, key, l.ownerID, ttl).Result()
	return ok, err
}

// releaseLua atomically checks the owner before deleting.
// Prevents releasing another instance's lock.
var releaseLua = redis.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
	return redis.call("DEL", KEYS[1])
else
	return 0
end
`)

func (l *redisFlushLock) Release(ctx context.Context, documentID string) error {
	key := flushLockPrefix + documentID
	_, err := releaseLua.Run(ctx, l.client, []string{key}, l.ownerID).Result()
	return err
}
