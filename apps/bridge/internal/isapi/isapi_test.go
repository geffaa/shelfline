package isapi

import (
	"bytes"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"
	"time"

	"shelfline/bridge/internal/queue"
)

type sink struct {
	got  []queue.Event
	fail error
}

func (s *sink) Push(e queue.Event) error {
	if s.fail != nil {
		return s.fail
	}
	s.got = append(s.got, e)
	return nil
}

const punch = `{"ipAddress":"10.0.0.7","macAddress":"aa:bb:cc:dd:ee:01","dateTime":"2026-11-10T09:00:03+10:00","eventType":"AccessControllerEvent","AccessControllerEvent":{"majorEventType":5,"subEventType":38,"employeeNoString":"117","currentVerifyMode":"cardOrFaceOrFp","attendanceStatus":"checkIn","deviceSerialNo":"DS-K1T-0042"}}`

func melbourne(t *testing.T) *time.Location {
	l, err := time.LoadLocation("Australia/Melbourne")
	if err != nil {
		t.Skip("no tzdata")
	}
	return l
}

func TestParseEvent(t *testing.T) {
	loc := melbourne(t)
	e, ok, err := ParseEvent("", []byte(punch), loc)
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if e.Serial != "DS-K1T-0042" || e.PersonCode != "117" || e.TS != "2026-11-10T09:00:03+10:00" || e.State != "in" || e.Verify != "fingerprint" {
		t.Fatalf("%+v", e)
	}
	// the serial in the push address wins; check-out; face by sub-event code; the offset-less time is read in the store's zone
	e, ok, _ = ParseEvent("LOBBY-1", []byte(strings.NewReplacer(`"cardOrFaceOrFp"`, `""`, `38`, `75`, `checkIn`, `checkOut`, `2026-11-10T09:00:03+10:00`, `2026-11-10T17:30:00`).Replace(punch)), loc)
	if !ok || e.Serial != "LOBBY-1" || e.State != "out" || e.Verify != "face" || e.TS != "2026-11-10T17:30:00+11:00" {
		t.Fatalf("%+v ok=%v", e, ok)
	}
	// breaks leave the direction to the server
	e, _, _ = ParseEvent("X", []byte(strings.Replace(punch, "checkIn", "breakOut", 1)), loc)
	if e.State != "" {
		t.Fatalf("break read as %q", e.State)
	}
}

func TestParseEventIgnoresWhatIsNotAttendance(t *testing.T) {
	loc := melbourne(t)
	for name, body := range map[string]string{
		"heartbeat":   `{"eventType":"heartBeat","dateTime":"2026-11-10T09:00:03+10:00"}`,
		"door open":   `{"eventType":"AccessControllerEvent","dateTime":"2026-11-10T09:00:03+10:00","AccessControllerEvent":{"majorEventType":5,"subEventType":21}}`,
		"blank staff": `{"eventType":"AccessControllerEvent","dateTime":"2026-11-10T09:00:03+10:00","AccessControllerEvent":{"employeeNoString":"  "}}`,
	} {
		if _, ok, err := ParseEvent("S", []byte(body), loc); ok || err != nil {
			t.Errorf("%s: ok=%v err=%v", name, ok, err)
		}
	}
	if _, _, err := ParseEvent("S", []byte("not json"), loc); err == nil {
		t.Error("garbage accepted")
	}
	if _, _, err := ParseEvent("S", []byte(strings.Replace(punch, "2026-11-10T09:00:03+10:00", "yesterday", 1)), loc); err == nil {
		t.Error("bad time accepted")
	}
	if _, _, err := ParseEvent("", []byte(`{"eventType":"AccessControllerEvent","dateTime":"2026-11-10T09:00:03+10:00","AccessControllerEvent":{"employeeNoString":"5"}}`), loc); err == nil {
		t.Error("an event from nobody was accepted")
	}
}

func TestHandler(t *testing.T) {
	loc := melbourne(t)
	s := &sink{}
	seen := map[string]int{}
	h := &Handler{Sink: s, Location: loc, Seen: func(sn string, n int) { seen[sn] += n }}
	mux := http.NewServeMux()
	h.Routes(mux)
	post := func(ct, body, q string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/hik/events"+q, strings.NewReader(body))
		r.Header.Set("Content-Type", ct)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	if w := post("application/json", punch, ""); w.Code != 200 || len(s.got) != 1 {
		t.Fatalf("%d %v", w.Code, s.got)
	}
	// the multipart form some firmware uses: the JSON is the event_log part
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	hd := textproto.MIMEHeader{}
	hd.Set("Content-Disposition", `form-data; name="event_log"`)
	hd.Set("Content-Type", "application/json")
	pw, _ := mw.CreatePart(hd)
	_, _ = pw.Write([]byte(strings.Replace(punch, "117", "118", 1)))
	_ = mw.Close()
	if w := post(mw.FormDataContentType(), buf.String(), ""); w.Code != 200 || len(s.got) != 2 || s.got[1].PersonCode != "118" {
		t.Fatalf("multipart: %d %v", w.Code, s.got)
	}
	// not attendance, malformed: acknowledged and dropped, so the terminal does not resend forever
	if w := post("application/json", `{"eventType":"heartBeat"}`, "?sn=Z9"); w.Code != 200 || len(s.got) != 2 || seen["Z9"] != 0 {
		t.Fatalf("heartbeat: %d", w.Code)
	}
	if w := post("application/json", "garbage", ""); w.Code != 200 || len(s.got) != 2 {
		t.Fatalf("garbage: %d", w.Code)
	}
	// when the queue cannot store, say so: the terminal keeps the event and sends it again
	s.fail = errors.New("disk full")
	if w := post("application/json", punch, ""); w.Code != http.StatusInternalServerError {
		t.Fatalf("storage failure answered %d", w.Code)
	}
	if w := httptest.NewRecorder(); true {
		mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/hik/events", nil))
		if w.Code != http.StatusMethodNotAllowed {
			t.Fatalf("GET answered %d", w.Code)
		}
	}
	if seen["DS-K1T-0042"] != 2 {
		t.Fatalf("seen %v", seen)
	}
}
