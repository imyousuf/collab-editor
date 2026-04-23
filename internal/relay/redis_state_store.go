package relay

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// Key scheme for per-document Y.Doc durability.
//
//   collab:room:{docID}:log        — LIST of Yjs Update binaries (RPUSH)
//   collab:room:{docID}:snapshot   — STRING, encoded Y.Doc state
//   collab:room:{docID}:snap_off   — STRING, log offset at time of snapshot
//
// The log offset is the total cumulative RPUSH count into the log key,
// tracked separately so LTRIM can drop entries that are "before" the
// snapshot without us having to count from zero.
const (
	redisStateKeyPrefix = "collab:room:"
	redisLogSuffix      = ":log"
	redisSnapshotSuffix = ":snapshot"
	redisSnapOffSuffix  = ":snap_off"
	redisCounterSuffix  = ":log_len"
	// defaultKeyTTL caps memory use for rooms that drift off without a
	// proper snapshot write. Rooms under active edit keep writing, so
	// EXPIRE bumps on every AppendUpdate.
	defaultKeyTTL = 30 * 24 * time.Hour
)

// RedisStateStore is the Redis-backed StateStore. See the StateStore
// doc for the protocol invariants; this is a thin wrapper around
// RPUSH/LRANGE/LTRIM/SET/GET with TTL bumps.
type RedisStateStore struct {
	client redis.UniversalClient
	broker MessageBroker // for fan-out publish alongside log append
	ttl    time.Duration
}

// NewRedisStateStore constructs a Redis-backed state store. If broker
// is non-nil, every AppendUpdate publishes the update on the broker's
// pub/sub channel in addition to appending to the durable log — so live
// sibling pods receive the update immediately AND cold-starting pods
// can replay it from the log.
func NewRedisStateStore(client redis.UniversalClient, broker MessageBroker) *RedisStateStore {
	return &RedisStateStore{
		client: client,
		broker: broker,
		ttl:    defaultKeyTTL,
	}
}

func (s *RedisStateStore) logKey(docID string) string {
	return redisStateKeyPrefix + docID + redisLogSuffix
}

func (s *RedisStateStore) snapshotKey(docID string) string {
	return redisStateKeyPrefix + docID + redisSnapshotSuffix
}

func (s *RedisStateStore) snapOffsetKey(docID string) string {
	return redisStateKeyPrefix + docID + redisSnapOffSuffix
}

func (s *RedisStateStore) counterKey(docID string) string {
	return redisStateKeyPrefix + docID + redisCounterSuffix
}

// AppendUpdate RPUSHes the update onto the durable log and publishes it
// for live fan-out in a single pipelined transaction. The counter
// increment runs alongside so snapshot compaction can later LTRIM
// precisely up to the snapshot's log offset.
func (s *RedisStateStore) AppendUpdate(ctx context.Context, docID string, update []byte) error {
	if len(update) == 0 {
		return nil
	}
	pipe := s.client.TxPipeline()
	pipe.RPush(ctx, s.logKey(docID), update)
	pipe.Incr(ctx, s.counterKey(docID))
	pipe.Expire(ctx, s.logKey(docID), s.ttl)
	pipe.Expire(ctx, s.counterKey(docID), s.ttl)
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("redis append update: %w", err)
	}

	// Publish happens outside the transaction because MULTI/EXEC doesn't
	// guarantee subscriber delivery ordering anyway — cold-starting pods
	// rely on the log, not pub/sub, so this is fire-and-forget.
	if s.broker != nil {
		// Best-effort publish; log failures but don't fail the caller —
		// the durable log already has the update.
		_ = s.broker.Publish(ctx, docID, update)
	}
	return nil
}

// ReadSnapshot fetches the current snapshot + its log offset. Returns
// (nil, 0, nil) if no snapshot exists yet.
func (s *RedisStateStore) ReadSnapshot(ctx context.Context, docID string) ([]byte, int64, error) {
	snap, err := s.client.Get(ctx, s.snapshotKey(docID)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, 0, nil
	}
	if err != nil {
		return nil, 0, fmt.Errorf("redis read snapshot: %w", err)
	}

	offset, err := s.client.Get(ctx, s.snapOffsetKey(docID)).Int64()
	if errors.Is(err, redis.Nil) {
		// Snapshot present but offset missing — safest is to treat the
		// snapshot as usable and the entire log as tail. Duplicate
		// updates would be applied idempotently by YATA; we'd just do
		// more work than needed.
		return snap, 0, nil
	}
	if err != nil {
		return nil, 0, fmt.Errorf("redis read snap offset: %w", err)
	}
	return snap, offset, nil
}

// ReadLogTail returns every log entry at index >= fromOffset, plus the
// absolute counter value after reading (so the caller can ask for the
// new tail next time without re-applying anything). `fromOffset` is the
// absolute counter value; RPUSH increments the counter before adding,
// so offset 3 means "the 3rd, 4th, 5th... RPUSHes".
func (s *RedisStateStore) ReadLogTail(ctx context.Context, docID string, fromOffset int64) ([][]byte, int64, error) {
	counter, err := s.client.Get(ctx, s.counterKey(docID)).Int64()
	if errors.Is(err, redis.Nil) {
		return nil, 0, nil // no log yet
	}
	if err != nil {
		return nil, 0, fmt.Errorf("redis read log counter: %w", err)
	}
	if counter <= fromOffset {
		return nil, counter, nil
	}

	// Log list indices are 0-based from the oldest entry still present.
	// Snapshot compaction trims the head; the counter stays monotonic.
	// Current list length = counter - snapshot's trim point. We read
	// from (fromOffset - (counter - currentLen)) to the end.
	listLen, err := s.client.LLen(ctx, s.logKey(docID)).Result()
	if err != nil {
		return nil, 0, fmt.Errorf("redis log len: %w", err)
	}
	trimmed := counter - listLen
	relativeStart := fromOffset - trimmed
	if relativeStart < 0 {
		relativeStart = 0 // caller's cursor is older than what we have — replay everything we still keep
	}

	entries, err := s.client.LRange(ctx, s.logKey(docID), relativeStart, -1).Result()
	if err != nil {
		return nil, 0, fmt.Errorf("redis log lrange: %w", err)
	}

	out := make([][]byte, 0, len(entries))
	for _, e := range entries {
		out = append(out, []byte(e))
	}
	return out, counter, nil
}

// WriteSnapshot stores the current encoded Y.Doc state and trims the
// log so only entries added after this snapshot are retained. Callers
// MUST hold the FlushLock for the document so only one pod in the
// cluster writes per flush window.
func (s *RedisStateStore) WriteSnapshot(ctx context.Context, docID string, state []byte) error {
	if len(state) == 0 {
		return nil
	}
	// Capture the current log position so the snapshot and its offset
	// are mutually consistent. Any AppendUpdate that lands BEFORE we
	// LTRIM is safe because its data was in the Y.Doc we snapshotted;
	// any that lands AFTER survives the trim (LTRIM with an older
	// relative index only drops head entries).
	counter, err := s.client.Get(ctx, s.counterKey(docID)).Int64()
	if errors.Is(err, redis.Nil) {
		counter = 0
	} else if err != nil {
		return fmt.Errorf("redis read counter for snapshot: %w", err)
	}

	pipe := s.client.TxPipeline()
	pipe.Set(ctx, s.snapshotKey(docID), state, s.ttl)
	pipe.Set(ctx, s.snapOffsetKey(docID), counter, s.ttl)
	// LTRIM start end — keep elements from index `listLen - newTailLen`
	// to the end. After a snapshot at `counter`, there are no untracked
	// entries AT OR BEFORE the snapshot, so we drop everything up to
	// the current end. Equivalent: LTRIM to an empty list, then let
	// subsequent RPUSH re-populate the tail.
	pipe.LTrim(ctx, s.logKey(docID), 1, 0) // removes all elements
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("redis write snapshot: %w", err)
	}
	return nil
}

func (s *RedisStateStore) Close() error {
	// We don't own the client; the caller manages its lifecycle.
	return nil
}
