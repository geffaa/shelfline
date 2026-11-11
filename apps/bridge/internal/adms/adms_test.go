package adms

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"shelfline/bridge/internal/queue"
)

type mem struct{ got []queue.Event }

func (m *mem) Push(e queue.Event) error { m.got = append(m.got, e); return nil }

func mel(t *testing.T) *time.Location {
	l, err := time.LoadLocation("Australia/Melbourne")
	if err != nil {
		t.Skip("no zone database")
	}
	return l
}

func TestParseLine(t *testing.T) {
	loc := mel(t)
	e, err := ParseLine("SN1", "117\t2026-11-04 09:12:00\t0\t1\t0\r\n", loc)
	if err != nil {
		t.Fatal(err)
	}
	if e.PersonCode != "117" || e.TS != "2026-11-04T09:12:00+11:00" || e.State != "in" || e.Verify != "fingerprint" || e.Serial != "SN1" {
		t.Fatalf("unexpected %+v", e)
	}
	cases := map[string][2]string{"117\t2026-11-04 17:00:00\t1\t15": {"out", "face"}, "9\t2026-11-04 17:00:00\t4\t2": {"", "card"}, "9\t2026-11-04 17:00:00\t\t0": {"", "password"}, "9\t2026-11-04 17:00:00": {"", "other"}, "9\t2026-11-04 17:00:00\t0\t77": {"in", "other"}}
	for line, want := range cases {
		e, err := ParseLine("S", line, loc)
		if err != nil || e.State != want[0] || e.Verify != want[1] {
			t.Errorf("%q: %+v %v, want %v", line, e, err, want)
		}
	}
	for _, bad := range []string{"", "\t2026-11-04 09:00:00", "117", "117\tyesterday"} {
		if _, err := ParseLine("S", bad, loc); err == nil {
			t.Errorf("%q should not parse", bad)
		}
	}
}

// The wall-clock time of a terminal in Melbourne means a different instant before and after the clocks change.
func TestParseLineAcrossDaylightSaving(t *testing.T) {
	loc := mel(t)
	a, _ := ParseLine("S", "1\t2026-10-03 22:00:00\t0\t1", loc)
	b, _ := ParseLine("S", "1\t2026-10-04 06:00:00\t1\t1", loc)
	ta, _ := time.Parse(time.RFC3339, a.TS)
	tb, _ := time.Parse(time.RFC3339, b.TS)
	if tb.Sub(ta) != 7*time.Hour {
		t.Fatalf("a night over the spring change is 7h, got %v", tb.Sub(ta))
	}
}

func TestHandler(t *testing.T) {
	loc := mel(t)
	m := &mem{}
	seen := map[string]int{}
	h := &Handler{Sink: m, Location: loc, Seen: func(s string, n int) { seen[s] += n }}
	mux := http.NewServeMux()
	h.Routes(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := http.Get(srv.URL + "/iclock/cdata?SN=ABC&options=all")
	if r.StatusCode != 200 {
		t.Fatalf("hello: %d", r.StatusCode)
	}
	body := "117\t2026-11-04 09:12:00\t0\t1\t0\n\nbroken line\n118\t2026-11-04 09:13:00\t\t15\t0\n"
	r, _ = http.Post(srv.URL+"/iclock/cdata?SN=ABC&table=ATTLOG", "text/plain", strings.NewReader(body))
	buf := make([]byte, 64)
	n, _ := r.Body.Read(buf)
	if string(buf[:n]) != "OK: 2" || len(m.got) != 2 || m.got[1].Verify != "face" {
		t.Fatalf("got %q %+v", buf[:n], m.got)
	}
	r, _ = http.Post(srv.URL+"/iclock/cdata?SN=ABC&table=OPERLOG", "text/plain", strings.NewReader("whatever"))
	if r.StatusCode != 200 || len(m.got) != 2 {
		t.Fatal("other tables are acknowledged and ignored")
	}
	r, _ = http.Get(srv.URL + "/iclock/getrequest?SN=ABC")
	if r.StatusCode != 200 || seen["ABC"] != 2 {
		t.Fatalf("seen %v", seen)
	}
	r, _ = http.Post(srv.URL+"/iclock/cdata", "text/plain", strings.NewReader("x"))
	if r.StatusCode != 400 {
		t.Fatal("a call without a serial is refused")
	}
}
