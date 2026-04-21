package spi

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"
)

func TestLoadRequestJSON(t *testing.T) {
	t.Run("with state vector", func(t *testing.T) {
		req := LoadRequest{StateVector: "AQAB"}
		data, err := json.Marshal(req)
		if err != nil {
			t.Fatal(err)
		}
		var got LoadRequest
		if err := json.Unmarshal(data, &got); err != nil {
			t.Fatal(err)
		}
		if got.StateVector != req.StateVector {
			t.Errorf("got %q, want %q", got.StateVector, req.StateVector)
		}
	})

	t.Run("empty omits state_vector", func(t *testing.T) {
		data, _ := json.Marshal(LoadRequest{})
		if string(data) != "{}" {
			t.Errorf("expected empty object, got %s", data)
		}
	})
}

func TestLoadResponseJSON(t *testing.T) {
	ts := time.Date(2026, 4, 14, 10, 30, 0, 0, time.UTC)
	resp := LoadResponse{
		Snapshot: &SnapshotPayload{
			Data:        "base64data",
			StateVector: "base64sv",
			CreatedAt:   ts,
			UpdateCount: 847,
		},
		Updates: []UpdatePayload{
			{Sequence: 848, Data: "upd1", ClientID: 123, CreatedAt: ts},
		},
		Metadata: &DocumentMetadata{
			Format:      "markdown",
			Language:    "javascript",
			CreatedBy:   "user-alice",
			Permissions: "read-write",
		},
	}

	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}

	var got LoadResponse
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}

	if got.Snapshot.Data != "base64data" {
		t.Errorf("snapshot data: got %q", got.Snapshot.Data)
	}
	if got.Snapshot.UpdateCount != 847 {
		t.Errorf("update count: got %d", got.Snapshot.UpdateCount)
	}
	if len(got.Updates) != 1 || got.Updates[0].Sequence != 848 {
		t.Errorf("updates: got %+v", got.Updates)
	}
	if got.Metadata.Format != "markdown" {
		t.Errorf("metadata format: got %q", got.Metadata.Format)
	}
}

func TestLoadResponseNoContent(t *testing.T) {
	resp := LoadResponse{}
	data, _ := json.Marshal(resp)
	var got LoadResponse
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got.Snapshot != nil {
		t.Error("expected nil snapshot")
	}
	if got.Updates != nil {
		t.Error("expected nil updates")
	}
}

func TestStoreRequestJSON(t *testing.T) {
	ts := time.Date(2026, 4, 14, 10, 32, 1, 123000000, time.UTC)
	req := StoreRequest{
		Updates: []UpdatePayload{
			{Sequence: 1042, Data: "d1", ClientID: 111, CreatedAt: ts},
			{Sequence: 1043, Data: "d2", ClientID: 222, CreatedAt: ts},
		},
	}

	data, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}

	var got StoreRequest
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Updates) != 2 {
		t.Fatalf("expected 2 updates, got %d", len(got.Updates))
	}
	if got.Updates[0].Sequence != 1042 || got.Updates[1].Sequence != 1043 {
		t.Errorf("sequences: %d, %d", got.Updates[0].Sequence, got.Updates[1].Sequence)
	}
}

func TestStoreResponseJSON(t *testing.T) {
	t.Run("full success", func(t *testing.T) {
		resp := StoreResponse{Stored: 2, DuplicatesIgnored: 0}
		data, _ := json.Marshal(resp)
		var got StoreResponse
		json.Unmarshal(data, &got)
		if got.Stored != 2 || got.Failed != nil {
			t.Errorf("got %+v", got)
		}
	})

	t.Run("partial failure", func(t *testing.T) {
		resp := StoreResponse{
			Stored: 1,
			Failed: []FailedUpdate{{Sequence: 1043, Error: "storage_full"}},
		}
		data, _ := json.Marshal(resp)
		var got StoreResponse
		json.Unmarshal(data, &got)
		if got.Stored != 1 || len(got.Failed) != 1 {
			t.Errorf("got %+v", got)
		}
		if got.Failed[0].Sequence != 1043 || got.Failed[0].Error != "storage_full" {
			t.Errorf("failed: %+v", got.Failed[0])
		}
	})

	t.Run("with version_created", func(t *testing.T) {
		ts := time.Date(2026, 4, 21, 10, 0, 0, 0, time.UTC)
		resp := StoreResponse{
			Stored: 2,
			VersionCreated: &VersionListEntry{
				ID:        "v-auto-1",
				CreatedAt: ts,
				Type:      "auto",
				Creator:   "system",
			},
		}
		data, _ := json.Marshal(resp)
		var got StoreResponse
		json.Unmarshal(data, &got)
		if got.VersionCreated == nil {
			t.Fatal("expected version_created")
		}
		if got.VersionCreated.ID != "v-auto-1" {
			t.Errorf("version id: got %q", got.VersionCreated.ID)
		}
		if got.VersionCreated.Type != "auto" {
			t.Errorf("version type: got %q", got.VersionCreated.Type)
		}
	})

	t.Run("without version_created omits field", func(t *testing.T) {
		resp := StoreResponse{Stored: 1}
		data, _ := json.Marshal(resp)
		if bytes.Contains(data, []byte("version_created")) {
			t.Error("version_created should be omitted when nil")
		}
	})
}

func TestCompactRequestJSON(t *testing.T) {
	ts := time.Date(2026, 4, 14, 10, 35, 0, 0, time.UTC)
	req := CompactRequest{
		Snapshot: SnapshotPayload{
			Data:        "snap",
			StateVector: "sv",
			CreatedAt:   ts,
			UpdateCount: 150,
		},
		ReplaceSequencesUpTo: 1043,
	}

	data, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}

	var got CompactRequest
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got.ReplaceSequencesUpTo != 1043 {
		t.Errorf("replace_sequences_up_to: got %d", got.ReplaceSequencesUpTo)
	}
	if got.Snapshot.UpdateCount != 150 {
		t.Errorf("snapshot update_count: got %d", got.Snapshot.UpdateCount)
	}
}

func TestCompactResponseJSON(t *testing.T) {
	resp := CompactResponse{Compacted: true, UpdatesRemoved: 150, SnapshotSizeBytes: 24576}
	data, _ := json.Marshal(resp)
	var got CompactResponse
	json.Unmarshal(data, &got)
	if !got.Compacted || got.UpdatesRemoved != 150 || got.SnapshotSizeBytes != 24576 {
		t.Errorf("got %+v", got)
	}
}

func TestHealthResponseJSON(t *testing.T) {
	resp := HealthResponse{Status: "ok", Storage: "connected"}
	data, _ := json.Marshal(resp)
	var got HealthResponse
	json.Unmarshal(data, &got)
	if got.Status != "ok" || got.Storage != "connected" {
		t.Errorf("got %+v", got)
	}
}

func TestErrorResponseJSON(t *testing.T) {
	resp := ErrorResponse{Error: "insufficient_permissions", Message: "Document requires write access"}
	data, _ := json.Marshal(resp)
	var got ErrorResponse
	json.Unmarshal(data, &got)
	if got.Error != "insufficient_permissions" {
		t.Errorf("got %+v", got)
	}
}

// TestJSONFieldNames verifies the wire format matches the SPI contract.
func TestJSONFieldNames(t *testing.T) {
	ts := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	tests := []struct {
		name     string
		v        any
		wantKeys []string
	}{
		{"UpdatePayload", UpdatePayload{Sequence: 1, Data: "d", ClientID: 2, CreatedAt: ts},
			[]string{"sequence", "data", "client_id", "created_at"}},
		{"SnapshotPayload", SnapshotPayload{Data: "d", StateVector: "sv", CreatedAt: ts, UpdateCount: 1},
			[]string{"data", "state_vector", "created_at", "update_count"}},
		{"DocumentMetadata", DocumentMetadata{Format: "md", Language: "js", CreatedBy: "a", Permissions: "rw"},
			[]string{"format", "language", "created_by", "permissions"}},
		{"StoreResponse", StoreResponse{Stored: 1, DuplicatesIgnored: 0},
			[]string{"stored", "duplicates_ignored"}},
		{"CompactRequest", CompactRequest{Snapshot: SnapshotPayload{Data: "d", StateVector: "sv", CreatedAt: ts}, ReplaceSequencesUpTo: 1},
			[]string{"snapshot", "replace_sequences_up_to"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data, _ := json.Marshal(tt.v)
			var m map[string]any
			json.Unmarshal(data, &m)
			for _, key := range tt.wantKeys {
				if _, ok := m[key]; !ok {
					t.Errorf("missing JSON key %q in %s", key, string(data))
				}
			}
		})
	}
}
