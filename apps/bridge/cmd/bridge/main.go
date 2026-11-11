// Command bridge sits on the store's network next to the attendance terminals. Terminals push their records to it; it keeps them on disk
// and forwards them to Shelfline in signed batches, whenever the internet allows.
package main

import (
	"flag"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // so zone names work on a bare device with no zoneinfo

	"shelfline/bridge/internal/adms"
	"shelfline/bridge/internal/isapi"
	"shelfline/bridge/internal/config"
	"shelfline/bridge/internal/printer"
	"shelfline/bridge/internal/queue"
	"shelfline/bridge/internal/sender"
)

type app struct {
	dir       string
	server    string
	q         *queue.Queue
	mu        sync.Mutex
	cfg       *config.Config
	terminals map[string]time.Time
	records   map[string]int
	started   time.Time
	sender    *sender.Sender
	relay     *printer.Relay
}

func (a *app) paired() *config.Config { a.mu.Lock(); defer a.mu.Unlock(); return a.cfg }

func main() {
	dir := flag.String("data", "bridge-data", "where the queue and the pairing live")
	server := flag.String("server", os.Getenv("SHELFLINE_URL"), "Shelfline server, e.g. https://shelfline.example.com")
	pair := flag.String("pair", "", "pairing code from the back office (first run)")
	listen := flag.String("listen", ":8240", "address the terminals and the status page use")
	tz := flag.String("tz", "Australia/Melbourne", "time zone the terminals' clocks are set to (replaced by the store's zone once paired)")
	every := flag.Duration("interval", 2*time.Second, "how often to forward queued records")
	flag.Parse()

	q, err := queue.Open(*dir)
	if err != nil {
		log.Fatalf("queue: %v", err)
	}
	a := &app{dir: *dir, server: strings.TrimRight(*server, "/"), q: q, terminals: map[string]time.Time{}, records: map[string]int{}, started: time.Now()}
	if *pair != "" {
		if a.server == "" {
			log.Fatal("--server is needed to pair")
		}
		c, err := config.Pair(a.server, *pair, nil)
		if err != nil {
			log.Fatalf("pair: %v", err)
		}
		if err := c.Save(*dir); err != nil {
			log.Fatalf("save: %v", err)
		}
		log.Printf("paired as %s for %s", c.BridgeID, c.Location)
	}
	if c, err := config.Load(*dir); err == nil {
		a.cfg = c
		if a.server == "" {
			a.server = c.Server
		}
		if c.Timezone != "" {
			*tz = c.Timezone
		}
	}
	loc, err := time.LoadLocation(*tz)
	if err != nil {
		log.Fatalf("time zone %q: %v", *tz, err)
	}

	h := &adms.Handler{Sink: q, Location: loc, Seen: func(serial string, n int) {
		a.mu.Lock()
		a.terminals[serial] = time.Now()
		a.records[serial] += n
		a.mu.Unlock()
	}}
	mux := http.NewServeMux()
	h.Routes(mux)
	(&isapi.Handler{Sink: q, Location: loc, Seen: h.Seen}).Routes(mux) // the second terminal dialect, on its own path
	mux.HandleFunc("/status", a.statusJSON)
	mux.HandleFunc("/pair", a.pairForm)
	mux.HandleFunc("/", a.page)

	var s *sender.Sender
	stop := make(chan struct{})
	go func() { // forward whenever paired; keep trying through outages
		wait := *every
		for {
			select {
			case <-stop:
				return
			case <-time.After(wait):
			}
			c := a.paired()
			if c == nil {
				continue
			}
			if s == nil {
				s = &sender.Sender{Q: q, Server: a.server, BridgeID: c.BridgeID, Secret: c.Secret}
				a.mu.Lock()
				a.sender = s
				a.mu.Unlock()
			}
			if _, err := s.Flush(); err != nil {
				if wait *= 2; wait > time.Minute {
					wait = time.Minute
				}
			} else {
				wait = *every
			}
		}
	}()
	go func() { // print whatever the back office or a till has queued for this store's printers
		for {
			time.Sleep(*every)
			c := a.paired()
			if c == nil {
				continue
			}
			a.mu.Lock()
			if a.relay == nil {
				a.relay = &printer.Relay{Server: a.server, BridgeID: c.BridgeID, Secret: c.Secret}
			}
			r := a.relay
			a.mu.Unlock()
			if _, err := r.Once(); err != nil {
				time.Sleep(5 * time.Second)
			}
		}
	}()
	log.Printf("bridge listening on %s (zone %s, queue %d waiting)", *listen, *tz, q.Len())
	log.Fatal(http.ListenAndServe(*listen, mux))
}

type statusDoc struct {
	Paired     bool              `json:"paired"`
	BridgeID   string            `json:"bridgeId,omitempty"`
	Location   string            `json:"location,omitempty"`
	Server     string            `json:"server"`
	Queued     int               `json:"queued"`
	SetAside   int               `json:"setAside"`
	Sender     sender.Status     `json:"sender"`
	Terminals  map[string]string `json:"terminals"`
	Records    map[string]int    `json:"records"`
	UptimeSecs int               `json:"uptimeSeconds"`
	Printing   printer.Status    `json:"printing"`
}

func (a *app) status() statusDoc {
	a.mu.Lock()
	defer a.mu.Unlock()
	d := statusDoc{Paired: a.cfg != nil, Server: a.server, Queued: a.q.Len(), SetAside: a.q.DeadLen(), Terminals: map[string]string{}, Records: map[string]int{}, UptimeSecs: int(time.Since(a.started).Seconds())}
	if a.cfg != nil {
		d.BridgeID, d.Location = a.cfg.BridgeID, a.cfg.Location
	}
	if a.sender != nil {
		d.Sender = a.sender.Status()
	}
	if a.relay != nil {
		d.Printing = a.relay.Status()
	}
	for k, v := range a.terminals {
		d.Terminals[k] = v.Format(time.RFC3339)
		d.Records[k] = a.records[k]
	}
	return d
}

var pageT = template.Must(template.New("p").Parse(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Shelfline bridge</title>
<style>body{font:15px/1.5 system-ui;max-width:640px;margin:32px auto;padding:0 16px;color:#14171C}h1{font-size:22px}table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid #dde;text-align:left}.ok{color:#116b3a}.bad{color:#a02020}input,button{font:inherit;padding:8px 10px}</style>
<h1>Shelfline bridge</h1>
<p>{{if .Paired}}<b class=ok>Paired</b> to {{.Location}} ({{.Server}}).{{else}}<b class=bad>Not paired.</b> Records from terminals are being kept safely until it is.{{end}}</p>
<p>Waiting to send: <b>{{.Queued}}</b>{{if .SetAside}} · set aside: <b class=bad>{{.SetAside}}</b>{{end}}</p>
<p>{{if .Sender.LastOKAt.IsZero}}Nothing sent yet.{{else}}Last delivered {{.Sender.LastOKAt.Format "15:04:05"}} (sent {{.Sender.Sent}}: {{.Sender.Accepted}} new, {{.Sender.Duplicates}} already known, {{.Sender.Review}} held for review).{{end}}{{if .Sender.LastError}}<br><span class=bad>Last problem: {{.Sender.LastError}}</span>{{end}}</p>
<p>Receipts printed: <b>{{.Printing.Printed}}</b>{{if .Printing.Failed}} · failed: <b class=bad>{{.Printing.Failed}}</b>{{end}}{{if .Printing.LastError}} · last problem: {{.Printing.LastError}}{{end}}</p>
<h2>Terminals</h2>{{if .Terminals}}<table><tr><th>Serial<th>Last contact<th>Records</tr>{{range $k, $v := .Terminals}}<tr><td>{{$k}}<td>{{$v}}<td>{{index $.Records $k}}</tr>{{end}}</table>{{else}}<p>No terminal has called yet. Point each terminal's server address at this machine, port {{.Port}}.</p>{{end}}
{{if not .Paired}}<h2>Pair</h2><form method=post action=/pair><p><input name=server placeholder="https://shelfline.example.com" value="{{.Server}}" size=34><br><br><input name=code placeholder="ABCD-EFGH" size=12> <button>Pair this bridge</button></p></form>{{end}}`))

func (a *app) page(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	d := a.status()
	keys := make([]string, 0)
	for k := range d.Terminals {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	w.Header().Set("content-type", "text/html; charset=utf-8")
	_ = pageT.Execute(w, struct {
		statusDoc
		Port string
	}{d, "8240"})
}

func (a *app) statusJSON(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("content-type", "application/json")
	d := a.status()
	fmt.Fprintf(w, `{"paired":%t,"bridgeId":%q,"location":%q,"server":%q,"queued":%d,"setAside":%d,"lastOkAt":%q,"lastError":%q,"sent":%d,"accepted":%d,"duplicates":%d,"needsReview":%d,"terminals":%d}`,
		d.Paired, d.BridgeID, d.Location, d.Server, d.Queued, d.SetAside, d.Sender.LastOKAt.Format(time.RFC3339), d.Sender.LastError, d.Sender.Sent, d.Sender.Accepted, d.Sender.Duplicates, d.Sender.Review, len(d.Terminals))
}

func (a *app) pairForm(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	server := strings.TrimRight(strings.TrimSpace(r.FormValue("server")), "/")
	c, err := config.Pair(server, strings.TrimSpace(r.FormValue("code")), nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := c.Save(a.dir); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	a.mu.Lock()
	a.cfg, a.server = c, server
	a.mu.Unlock()
	http.Redirect(w, r, "/", http.StatusSeeOther)
}
