// Package isapi takes attendance events pushed by terminals that speak the "HTTP listening" dialect of the ISAPI family
// (the JSON AccessControllerEvent that Hikvision-style access and attendance terminals post, bare or as the `event_log`
// part of a multipart request). It is the bridge's second terminal adapter, next to ZKTeco-style ADMS.
//
// The field names and numeric codes below come from public integration notes, not from the vendor's full specification, and
// have not been checked against a real device (see docs/HARDWARE-TESTS.md, V09b).
package isapi

import (
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strings"
	"time"

	"shelfline/bridge/internal/queue"
)

type Sink interface{ Push(queue.Event) error }

type Handler struct {
	Sink     Sink
	Location *time.Location             // used only when a terminal sends a time without an offset
	Seen     func(serial string, n int) // called for every contact, with the number of attendance records it carried
}

type payload struct {
	MAC       string `json:"macAddress"`
	DeviceID  string `json:"deviceID"`
	DateTime  string `json:"dateTime"`
	EventType string `json:"eventType"`
	Access    *struct {
		EmployeeNo string `json:"employeeNoString"`
		Verify     string `json:"currentVerifyMode"`
		Attendance string `json:"attendanceStatus"`
		Major      int    `json:"majorEventType"`
		Minor      int    `json:"subEventType"`
		Serial     string `json:"deviceSerialNo"`
	} `json:"AccessControllerEvent"`
}

// verifyName maps the verification mode. The sub-event codes 38 (fingerprint) and 75 (face) are the commonly reported ones;
// the textual mode is preferred when the terminal sends it.
func verifyName(mode string, minor int) string {
	m := strings.ToLower(mode)
	switch {
	case strings.Contains(m, "fp") || strings.Contains(m, "finger"):
		return "fingerprint"
	case strings.Contains(m, "face"):
		return "face"
	case strings.Contains(m, "card"):
		return "card"
	case strings.Contains(m, "pw") || strings.Contains(m, "pass"):
		return "password"
	}
	switch minor {
	case 38:
		return "fingerprint"
	case 75:
		return "face"
	case 1:
		return "card"
	}
	return "other"
}

// stateName: only check-in and check-out are relied on; breaks and overtime leave the direction to the server.
func stateName(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "checkin":
		return "in"
	case "checkout":
		return "out"
	}
	return ""
}

// ParseEvent turns one pushed event into a queue event. ok is false for events that are not attendance (door open, tamper, heartbeat).
func ParseEvent(serial string, body []byte, loc *time.Location) (e queue.Event, ok bool, err error) {
	var p payload
	if err := json.Unmarshal(body, &p); err != nil {
		return e, false, fmt.Errorf("not JSON: %w", err)
	}
	if p.EventType != "AccessControllerEvent" || p.Access == nil || strings.TrimSpace(p.Access.EmployeeNo) == "" {
		return e, false, nil
	}
	if serial == "" {
		serial = firstNonEmpty(p.Access.Serial, p.DeviceID, p.MAC)
	}
	if serial == "" {
		return e, false, fmt.Errorf("no way to tell which terminal sent this")
	}
	t, err := time.Parse(time.RFC3339, p.DateTime)
	if err != nil {
		if t, err = time.ParseInLocation("2006-01-02T15:04:05", p.DateTime, loc); err != nil {
			return e, false, fmt.Errorf("bad time %q", p.DateTime)
		}
	}
	return queue.Event{Serial: serial, PersonCode: strings.TrimSpace(p.Access.EmployeeNo), TS: t.Format(time.RFC3339), Verify: verifyName(p.Access.Verify, p.Access.Minor), State: stateName(p.Access.Attendance)}, true, nil
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

func (h *Handler) Routes(mux *http.ServeMux) { mux.HandleFunc("/hik/events", h.events) }

func (h *Handler) events(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	body, err := readEvent(r)
	if err != nil {
		http.Error(w, "unreadable", http.StatusBadRequest)
		return
	}
	serial := r.URL.Query().Get("sn")
	e, ok, err := ParseEvent(serial, body, h.Location)
	if err != nil { // a malformed event is acknowledged and dropped: resending it would not make it parse
		h.seen(serial, 0)
		_, _ = io.WriteString(w, "OK")
		return
	}
	if !ok {
		h.seen(firstNonEmpty(serial, e.Serial), 0)
		_, _ = io.WriteString(w, "OK")
		return
	}
	if err := h.Sink.Push(e); err != nil {
		http.Error(w, "could not store", http.StatusInternalServerError) // the terminal keeps the event and sends it again
		return
	}
	h.seen(e.Serial, 1)
	_, _ = io.WriteString(w, "OK")
}

// readEvent returns the JSON of a bare or multipart push (the JSON is the part named event_log).
func readEvent(r *http.Request) ([]byte, error) {
	mt, params, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if strings.HasPrefix(mt, "multipart/") {
		mr := multipart.NewReader(io.LimitReader(r.Body, 8<<20), params["boundary"])
		for {
			p, err := mr.NextPart()
			if err != nil {
				return nil, err
			}
			if p.FormName() == "event_log" || strings.HasPrefix(p.Header.Get("Content-Type"), "application/json") {
				return io.ReadAll(io.LimitReader(p, 1<<20))
			}
		}
	}
	return io.ReadAll(io.LimitReader(r.Body, 1<<20))
}

func (h *Handler) seen(serial string, n int) {
	if h.Seen != nil && serial != "" {
		h.Seen(serial, n)
	}
}
