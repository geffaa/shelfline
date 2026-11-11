// Package adms speaks the small HTTP "push" dialect that ZKTeco-family attendance terminals use (often called ADMS):
// the terminal calls /iclock/cdata to say hello and to upload attendance lines (tab separated: PIN, time, status, verify),
// and polls /iclock/getrequest for commands. Field meanings below come from third-party implementations, not from the vendor's
// full specification, and have not been checked against a real device (see TECH-SPEC V09).
package adms

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"shelfline/bridge/internal/queue"
)

// Sink receives normalised events; the bridge's sink is the durable queue.
type Sink interface{ Push(queue.Event) error }

type Handler struct {
	Sink     Sink
	Location *time.Location          // the terminals' clocks are wall-clock times in this zone
	Seen     func(serial string, n int) // called for every contact, with the number of records it carried
	Now      func() time.Time
}

// verifyName maps the numeric verification type. 1 = fingerprint and 15 = face are the commonly reported values.
func verifyName(code string) string {
	switch strings.TrimSpace(code) {
	case "1":
		return "fingerprint"
	case "15":
		return "face"
	case "2", "4":
		return "card"
	case "0", "3":
		return "password"
	}
	return "other"
}

// stateName maps the terminal's punch state: 0 check-in and 1 check-out are the only ones relied on; anything else leaves the
// direction to the server (which alternates).
func stateName(code string) string {
	switch strings.TrimSpace(code) {
	case "0":
		return "in"
	case "1":
		return "out"
	}
	return ""
}

// ParseLine turns one ATTLOG line into an event.
func ParseLine(serial, line string, loc *time.Location) (queue.Event, error) {
	f := strings.Split(strings.TrimRight(line, "\r\n"), "\t")
	if len(f) < 2 || strings.TrimSpace(f[0]) == "" {
		return queue.Event{}, fmt.Errorf("short attendance line %q", line)
	}
	t, err := time.ParseInLocation("2006-01-02 15:04:05", strings.TrimSpace(f[1]), loc)
	if err != nil {
		return queue.Event{}, fmt.Errorf("bad time in %q: %w", line, err)
	}
	e := queue.Event{Serial: serial, PersonCode: strings.TrimSpace(f[0]), TS: t.Format(time.RFC3339), Verify: "other"}
	if len(f) > 2 {
		e.State = stateName(f[2])
	}
	if len(f) > 3 {
		e.Verify = verifyName(f[3])
	}
	return e, nil
}

func (h *Handler) Routes(mux *http.ServeMux) {
	mux.HandleFunc("/iclock/cdata", h.cdata)
	mux.HandleFunc("/iclock/getrequest", h.getrequest)
	mux.HandleFunc("/iclock/devicecmd", func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "OK") })
}

func (h *Handler) cdata(w http.ResponseWriter, r *http.Request) {
	serial := r.URL.Query().Get("SN")
	if serial == "" {
		http.Error(w, "missing SN", http.StatusBadRequest)
		return
	}
	if r.Method == http.MethodGet { // hello / option exchange
		h.seen(serial, 0)
		fmt.Fprintf(w, "GET OPTION FROM: %s\nStamp=9999\nOpStamp=9999\nErrorDelay=60\nDelay=10\nTransTimes=00:00;14:00\nTransInterval=1\nTransFlag=TransData AttLog\nRealtime=1\nEncrypt=0\n", serial)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		http.Error(w, "read error", http.StatusBadRequest)
		return
	}
	if r.URL.Query().Get("table") != "ATTLOG" { // user lists, photos, operation logs: not ours to keep
		h.seen(serial, 0)
		_, _ = io.WriteString(w, "OK")
		return
	}
	n := 0
	for _, line := range strings.Split(string(body), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		e, err := ParseLine(serial, line, h.Location)
		if err != nil {
			continue // a malformed line is skipped, not allowed to lose the rest of the upload
		}
		if err := h.Sink.Push(e); err != nil {
			http.Error(w, "could not store", http.StatusInternalServerError) // the terminal keeps its records and tries again
			return
		}
		n++
	}
	h.seen(serial, n)
	fmt.Fprintf(w, "OK: %d", n)
}

func (h *Handler) getrequest(w http.ResponseWriter, r *http.Request) {
	if sn := r.URL.Query().Get("SN"); sn != "" {
		h.seen(sn, 0)
	}
	_, _ = io.WriteString(w, "OK")
}

func (h *Handler) seen(serial string, n int) {
	if h.Seen != nil {
		h.Seen(serial, n)
	}
}
