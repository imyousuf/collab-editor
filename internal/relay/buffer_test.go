package relay

import (
	"sync"
	"testing"
)

func TestUpdateBuffer_AppendAndDrain(t *testing.T) {
	buf := NewUpdateBuffer()

	buf.Append([]byte("hello"), 100)
	buf.Append([]byte("world"), 200)

	if buf.Len() != 2 {
		t.Errorf("len: got %d, want 2", buf.Len())
	}
	if buf.Size() != 10 {
		t.Errorf("size: got %d, want 10", buf.Size())
	}

	updates := buf.Drain()
	if len(updates) != 2 {
		t.Fatalf("drain: got %d updates, want 2", len(updates))
	}
	if updates[0].Sequence != 1 || updates[1].Sequence != 2 {
		t.Errorf("sequences: %d, %d", updates[0].Sequence, updates[1].Sequence)
	}
	if string(updates[0].Data) != "hello" {
		t.Errorf("data[0]: got %q", updates[0].Data)
	}

	// After drain, buffer should be empty
	if buf.Len() != 0 || buf.Size() != 0 {
		t.Errorf("after drain: len=%d, size=%d", buf.Len(), buf.Size())
	}
}

func TestUpdateBuffer_DrainEmpty(t *testing.T) {
	buf := NewUpdateBuffer()
	updates := buf.Drain()
	if updates != nil {
		t.Errorf("expected nil for empty drain, got %v", updates)
	}
}

func TestUpdateBuffer_Prepend(t *testing.T) {
	buf := NewUpdateBuffer()
	buf.Append([]byte("c"), 300)

	buf.Prepend([]BufferedUpdate{
		{Sequence: 10, Data: []byte("a"), ClientID: 100},
		{Sequence: 20, Data: []byte("b"), ClientID: 200},
	})

	if buf.Len() != 3 {
		t.Fatalf("len: got %d, want 3", buf.Len())
	}

	updates := buf.Drain()
	if updates[0].Sequence != 10 || updates[1].Sequence != 20 || updates[2].Sequence != 1 {
		t.Errorf("order after prepend: %d, %d, %d", updates[0].Sequence, updates[1].Sequence, updates[2].Sequence)
	}
}

func TestUpdateBuffer_SizeTracking(t *testing.T) {
	buf := NewUpdateBuffer()

	size := buf.Append(make([]byte, 1000), 1)
	if size != 1000 {
		t.Errorf("after first: got %d", size)
	}

	size = buf.Append(make([]byte, 500), 2)
	if size != 1500 {
		t.Errorf("after second: got %d", size)
	}

	buf.Drain()
	if buf.Size() != 0 {
		t.Errorf("after drain: got %d", buf.Size())
	}
}

func TestUpdateBuffer_ConcurrentAccess(t *testing.T) {
	buf := NewUpdateBuffer()
	var wg sync.WaitGroup

	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			buf.Append([]byte("data"), 1)
		}()
	}
	wg.Wait()

	if buf.Len() != 100 {
		t.Errorf("concurrent append: got %d, want 100", buf.Len())
	}
}

func TestToPayloads(t *testing.T) {
	updates := []BufferedUpdate{
		{Sequence: 1, Data: []byte{0x01, 0x02}, ClientID: 100},
	}
	payloads := ToPayloads(updates)
	if len(payloads) != 1 {
		t.Fatal("expected 1 payload")
	}
	if payloads[0].Data != "AQI=" { // base64 of [0x01, 0x02]
		t.Errorf("base64 data: got %q", payloads[0].Data)
	}
}
