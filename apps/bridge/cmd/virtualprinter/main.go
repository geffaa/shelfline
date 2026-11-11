// Command virtualprinter is a receipt printer that is not there: it listens on the ESC/POS port, decodes what it is sent, and shows it as text on a web page
// and on the console. For the demo and for tests; a real printer replaces it by changing one address in Shelfline.
package main

import (
	"flag"
	"fmt"
	"html/template"
	"io"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"shelfline/bridge/internal/escpos"
)

type printed struct {
	At   time.Time
	Text string
	Cuts int
	Kick int
	Code []string
}

var (
	mu   sync.Mutex
	jobs []printed
)

var page = template.Must(template.New("p").Parse(`<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=3><title>Virtual printer</title>
<style>body{font:14px system-ui;margin:24px;color:#14171C}.r{display:inline-block;vertical-align:top;margin:0 16px 16px 0;background:#fff;border:1px solid #D8DDE4;padding:14px 16px;box-shadow:0 1px 0 #D8DDE4}pre{margin:0;font:13px/1.35 ui-monospace,Menlo,monospace}.k{display:inline-block;background:#C9E73A;padding:2px 8px;border-radius:99px;font-weight:700}</style>
<h1>Virtual receipt printer</h1><p>{{len .}} printed. This page refreshes itself.</p>
{{range .}}<div class=r><pre>{{.Text}}</pre><p>{{if .Kick}}<span class=k>drawer opened</span> {{end}}{{if .Cuts}}✂ cut{{end}} · {{.At.Format "15:04:05"}}</p></div>{{end}}`))

func main() {
	listen := flag.String("listen", ":9100", "ESC/POS port")
	web := flag.String("web", ":9101", "page that shows what was printed")
	flag.Parse()
	l, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatal(err)
	}
	go func() {
		http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			rev := make([]printed, len(jobs))
			for i, j := range jobs {
				rev[len(jobs)-1-i] = j
			}
			mu.Unlock()
			_ = page.Execute(w, rev)
		})
		log.Fatal(http.ListenAndServe(*web, nil))
	}()
	log.Printf("virtual printer: ESC/POS on %s, page on %s", *listen, *web)
	for {
		c, err := l.Accept()
		if err != nil {
			log.Fatal(err)
		}
		go func() {
			defer c.Close()
			_ = c.SetReadDeadline(time.Now().Add(15 * time.Second))
			b, _ := io.ReadAll(c)
			p := escpos.Decode(b)
			mu.Lock()
			jobs = append(jobs, printed{At: time.Now(), Text: p.Text(), Cuts: p.Cuts, Kick: p.DrawerKicks, Code: p.Barcodes})
			if len(jobs) > 50 {
				jobs = jobs[1:]
			}
			mu.Unlock()
			fmt.Printf("---- printed (%d bytes, %d cut, %d drawer) ----\n%s\n", len(b), p.Cuts, p.DrawerKicks, p.Text())
		}()
	}
}
