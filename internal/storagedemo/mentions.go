package storagedemo

import (
	"sort"
	"strings"
	"sync"

	"github.com/imyousuf/collab-editor/pkg/spi"
)

// MentionDirectory is an in-memory user directory used by the demo
// provider's @-mention search. Real providers would query LDAP, a DB, etc.
type MentionDirectory struct {
	mu    sync.RWMutex
	users []spi.MentionCandidate
}

func NewMentionDirectory(users []spi.MentionCandidate) *MentionDirectory {
	copied := make([]spi.MentionCandidate, len(users))
	copy(copied, users)
	return &MentionDirectory{users: copied}
}

// ToMentionCandidates converts config entries into wire types.
func ToMentionCandidates(entries []UserDirectoryEntry) []spi.MentionCandidate {
	out := make([]spi.MentionCandidate, 0, len(entries))
	for _, e := range entries {
		out = append(out, spi.MentionCandidate{
			UserID:      e.UserID,
			DisplayName: e.DisplayName,
			AvatarURL:   e.AvatarURL,
		})
	}
	return out
}

func (md *MentionDirectory) Size() int {
	md.mu.RLock()
	defer md.mu.RUnlock()
	return len(md.users)
}

// Search returns up to ``limit`` candidates whose display_name OR user_id
// contains the query (case-insensitive). When query is empty, returns the
// first ``limit`` entries sorted alphabetically.
func (md *MentionDirectory) Search(query string, limit int) []spi.MentionCandidate {
	md.mu.RLock()
	defer md.mu.RUnlock()
	if limit <= 0 {
		limit = 10
	}

	q := strings.ToLower(strings.TrimSpace(query))
	var matches []spi.MentionCandidate
	if q == "" {
		matches = append(matches, md.users...)
	} else {
		for _, u := range md.users {
			if strings.Contains(strings.ToLower(u.DisplayName), q) ||
				strings.Contains(strings.ToLower(u.UserID), q) {
				matches = append(matches, u)
			}
		}
	}

	sort.Slice(matches, func(i, j int) bool {
		return strings.ToLower(matches[i].DisplayName) < strings.ToLower(matches[j].DisplayName)
	})
	if len(matches) > limit {
		matches = matches[:limit]
	}
	return matches
}
