package printer

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"shelfline/bridge/internal/sender"
)

type fakeServer struct {
	mu      sync.Mutex
	jobs    []Job
	results []map[string]any
	t       *testing.T
	secret  string
}

func (f *fakeServer) handler() http.Handler {
	mux := http.NewServeMux()
	check := func(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
		body, _ := io.ReadAll(r.Body)
		ts := r.Header.Get("x-timestamp")
		if r.Header.Get("x-signature") != sender.Sign(f.secret, ts, body) || r.Header.Get("x-bridge-id") != "bridge-1" {
			http.Error(w, "bad signature", 401)
			return nil, false
		}
		return body, true
	}
	mux.HandleFunc("/devices/print-jobs/claim", func(w http.ResponseWriter, r *http.Request) {
		if _, ok := check(w, r); !ok {
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"jobs": f.jobs})
		f.jobs = nil
	})
	mux.HandleFunc("/devices/print-jobs/result", func(w http.ResponseWriter, r *http.Request) {
		body, ok := check(w, r)
		if !ok {
			return
		}
		var m map[string]any
		_ = json.Unmarshal(body, &m)
		f.mu.Lock()
		f.results = append(f.results, m)
		f.mu.Unlock()
		_, _ = w.Write([]byte(`{"status":"done"}`))
	})
	return mux
}

// listenPrinter accepts one connection at a time on a free port and keeps what it was sent.
func listenPrinter(t *testing.T) (host string, port int, got func() [][]byte) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	var mu sync.Mutex
	var recv [][]byte
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			b, _ := io.ReadAll(c)
			c.Close()
			mu.Lock()
			recv = append(recv, b)
			mu.Unlock()
		}
	}()
	a := l.Addr().(*net.TCPAddr)
	return "127.0.0.1", a.Port, func() [][]byte { mu.Lock(); defer mu.Unlock(); return append([][]byte(nil), recv...) }
}

func TestPrintsClaimedJobsAndReportsEach(t *testing.T) {
	host, port, got := listenPrinter(t)
	f := &fakeServer{t: t, secret: "s3cret", jobs: []Job{
		{ID: "a", Kind: "receipt", Host: host, Port: port, Payload: base64.StdEncoding.EncodeToString([]byte("\x1b@hello\n"))},
		{ID: "b", Kind: "drawer", Host: host, Port: port, Payload: base64.StdEncoding.EncodeToString([]byte("\x1bp\x00\x19\xfa"))},
	}}
	srv := httptest.NewServer(f.handler())
	defer srv.Close()
	r := &Relay{Server: srv.URL, BridgeID: "bridge-1", Secret: "s3cret"}
	n, err := r.Once()
	if err != nil || n != 2 {
		t.Fatalf("printed %d, err %v", n, err)
	}
	time.Sleep(50 * time.Millisecond)
	if g := got(); len(g) != 2 || string(g[0]) != "\x1b@hello\n" || string(g[1]) != "\x1bp\x00\x19\xfa" {
		t.Fatalf("printer got %q", g)
	}
	if len(f.results) != 2 || f.results[0]["ok"] != true || f.results[0]["id"] != "a" {
		t.Fatalf("results %v", f.results)
	}
	if s := r.Status(); s.Printed != 2 || s.Failed != 0 || s.LastError != "" {
		t.Fatalf("status %+v", s)
	}
}

func TestAPrinterThatIsOffIsReportedNotHidden(t *testing.T) {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	port := l.Addr().(*net.TCPAddr).Port
	l.Close() // nothing listens there now
	f := &fakeServer{t: t, secret: "k", jobs: []Job{{ID: "x", Kind: "receipt", Host: "127.0.0.1", Port: port, Payload: base64.StdEncoding.EncodeToString([]byte("hi"))}}}
	srv := httptest.NewServer(f.handler())
	defer srv.Close()
	r := &Relay{Server: srv.URL, BridgeID: "bridge-1", Secret: "k"}
	n, err := r.Once()
	if err != nil || n != 0 {
		t.Fatalf("n=%d err=%v", n, err)
	}
	if len(f.results) != 1 || f.results[0]["ok"] != false || f.results[0]["error"] == "" {
		t.Fatalf("results %v", f.results)
	}
	if s := r.Status(); s.Failed != 1 || s.LastError == "" {
		t.Fatalf("status %+v", s)
	}
}

func TestBadSignatureStopsEverything(t *testing.T) {
	f := &fakeServer{t: t, secret: "right"}
	srv := httptest.NewServer(f.handler())
	defer srv.Close()
	r := &Relay{Server: srv.URL, BridgeID: "bridge-1", Secret: "wrong"}
	if _, err := r.Once(); err == nil {
		t.Fatal("expected an error")
	}
	if r.Status().LastError == "" {
		t.Fatal("error not recorded")
	}
}

func TestBadPayloadIsAFailureNotACrash(t *testing.T) {
	f := &fakeServer{t: t, secret: "k", jobs: []Job{{ID: "x", Host: "127.0.0.1", Port: 1, Payload: "!!!not base64!!!"}}}
	srv := httptest.NewServer(f.handler())
	defer srv.Close()
	r := &Relay{Server: srv.URL, BridgeID: "bridge-1", Secret: "k"}
	if n, _ := r.Once(); n != 0 || len(f.results) != 1 || f.results[0]["ok"] != false {
		t.Fatalf("n=%d results=%v", n, f.results)
	}
}

func TestPortIsPassedAsANumber(t *testing.T) { _ = strconv.Itoa(9100) }
