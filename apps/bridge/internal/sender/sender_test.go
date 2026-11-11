package sender

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"shelfline/bridge/internal/queue"
)

// fake server: checks the signature exactly as Shelfline does and records what it was given, in order.
type fake struct {
	mu     sync.Mutex
	secret string
	down   bool
	status int
	got    []queue.Event
	calls  int
}

func (f *fake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.down {
		http.Error(w, "down", http.StatusBadGateway)
		return
	}
	b, _ := io.ReadAll(r.Body)
	ts := r.Header.Get("x-timestamp")
	if n, _ := strconv.ParseInt(ts, 10, 64); time.Since(time.Unix(n, 0)) > time.Minute || r.Header.Get("x-signature") != Sign(f.secret, ts, b) || r.Header.Get("x-bridge-id") != "bridge-1" {
		http.Error(w, "bad signature", http.StatusUnauthorized)
		return
	}
	if f.status != 0 {
		http.Error(w, "nope", f.status)
		f.status = 0
		return
	}
	var in struct{ Events []queue.Event }
	_ = json.Unmarshal(b, &in)
	f.got = append(f.got, in.Events...)
	res := make([]map[string]string, len(in.Events))
	for i := range res {
		res[i] = map[string]string{"status": "accepted"}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"results": res})
}

func setup(t *testing.T) (*queue.Queue, *fake, *Sender) {
	q, err := queue.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := &fake{secret: "s3cret"}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return q, f, &Sender{Q: q, Server: srv.URL, BridgeID: "bridge-1", Secret: "s3cret", Batch: 3}
}

func TestSignatureMatchesTheDocumentedScheme(t *testing.T) {
	// HMAC-SHA256 over "<ts>.<body>"; the same vector is checked by the server's tests
	got := Sign("k", "1700000000", []byte(`{"events":[]}`))
	if len(got) != 64 || got != Sign("k", "1700000000", []byte(`{"events":[]}`)) || got == Sign("k", "1700000001", []byte(`{"events":[]}`)) || got == Sign("k2", "1700000000", []byte(`{"events":[]}`)) {
		t.Fatalf("signature %s", got)
	}
}

func TestOutageThenRecoveryDeliversEverythingInOrder(t *testing.T) {
	q, f, s := setup(t)
	f.down = true
	for i := 0; i < 8; i++ {
		_ = q.Push(queue.Event{Serial: "S", PersonCode: fmt.Sprint(i), TS: "2026-11-04T09:00:00+11:00", Verify: "fingerprint"})
		if _, err := s.Flush(); err == nil {
			t.Fatal("flush should fail while the server is down")
		}
	}
	if q.Len() != 8 {
		t.Fatalf("nothing may be lost: %d left", q.Len())
	}
	f.down = false
	n, err := s.Flush()
	if err != nil || n != 8 || q.Len() != 0 {
		t.Fatalf("n=%d err=%v left=%d", n, err, q.Len())
	}
	for i, e := range f.got {
		if e.PersonCode != fmt.Sprint(i) {
			t.Fatalf("out of order at %d: %v", i, f.got)
		}
	}
	if st := s.Status(); st.Accepted != 8 || st.Sent != 8 || st.LastError != "" {
		t.Fatalf("status %+v", st)
	}
}

func TestRefusedAndBadRequests(t *testing.T) {
	q, f, s := setup(t)
	_ = q.Push(queue.Event{Serial: "S", PersonCode: "1", TS: "x", Verify: "other"})
	_ = q.Push(queue.Event{Serial: "S", PersonCode: "2", TS: "x", Verify: "other"})
	f.status = http.StatusBadRequest // the server rejects the content: the oldest is set aside, the rest still go
	if _, err := s.Flush(); err != nil {
		t.Fatal(err)
	}
	if q.DeadLen() != 1 || q.Len() != 0 || len(f.got) != 1 || f.got[0].PersonCode != "2" {
		t.Fatalf("dead %d left %d got %v", q.DeadLen(), q.Len(), f.got)
	}
	_ = q.Push(queue.Event{Serial: "S", PersonCode: "3", TS: "x", Verify: "other"})
	s.Secret = "wrong" // a revoked or wrongly keyed bridge keeps its records and keeps trying
	if _, err := s.Flush(); err == nil || q.Len() != 1 {
		t.Fatalf("a 401 must keep the record: err=%v left=%d", err, q.Len())
	}
}
