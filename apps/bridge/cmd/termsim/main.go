// Command termsim pretends to be an attendance terminal for demos and tests. By default it is ZKTeco-family (ADMS): it says hello to the bridge and pushes attendance lines.
// With -dialect isapi it posts the JSON event a Hikvision-style terminal pushes instead.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func main() {
	bridge := flag.String("bridge", "http://127.0.0.1:8240", "the bridge's address")
	serial := flag.String("serial", "CGRC000001", "terminal serial number")
	person := flag.String("person", "117", "person code (PIN) on the terminal")
	verify := flag.String("verify", "1", "verification type: 1 fingerprint, 15 face, 2 card, 0 password")
	state := flag.String("state", "", "punch state: 0 in, 1 out, empty to let the server alternate")
	at := flag.String("at", "", `device time "2006-01-02 15:04:05" (default: now)`)
	repeat := flag.Int("repeat", 1, "send the same record this many times (a terminal retries until it hears OK)")
	dialect := flag.String("dialect", "adms", "adms (ZKTeco-family) or isapi (Hikvision-style JSON push)")
	flag.Parse()

	when := *at
	if when == "" {
		when = time.Now().Format("2006-01-02 15:04:05")
	}
	get := func(path string) {
		res, err := http.Get(*bridge + path)
		if err != nil {
			log.Fatalf("%s: %v", path, err)
		}
		defer res.Body.Close()
		io.Copy(io.Discard, res.Body)
	}
	if *dialect == "isapi" {
		mode := map[string]string{"1": "cardOrFaceOrFp", "15": "faceOrFp", "2": "card", "0": "password"}[*verify]
		status := map[string]string{"0": "checkIn", "1": "checkOut"}[*state]
		t := time.Now()
		if *at != "" {
			t, _ = time.ParseInLocation("2006-01-02 15:04:05", *at, time.Local)
		}
		body, _ := json.Marshal(map[string]any{"eventType": "AccessControllerEvent", "dateTime": t.Format(time.RFC3339), "AccessControllerEvent": map[string]any{"majorEventType": 5, "subEventType": 38, "employeeNoString": *person, "currentVerifyMode": mode, "attendanceStatus": status}})
		for i := 0; i < *repeat; i++ {
			res, err := http.Post(*bridge+"/hik/events?sn="+url.QueryEscape(*serial), "application/json", bytes.NewReader(body))
			if err != nil {
				log.Fatalf("push: %v", err)
			}
			b, _ := io.ReadAll(res.Body)
			res.Body.Close()
			fmt.Printf("%s %s -> %s\n", *serial, *person, strings.TrimSpace(string(b)))
		}
		return
	}
	get("/iclock/cdata?SN=" + url.QueryEscape(*serial) + "&options=all")
	line := strings.Join([]string{*person, when, *state, *verify, "0"}, "\t") + "\n"
	for i := 0; i < *repeat; i++ {
		res, err := http.Post(*bridge+"/iclock/cdata?SN="+url.QueryEscape(*serial)+"&table=ATTLOG&Stamp=9999", "text/plain", strings.NewReader(line))
		if err != nil {
			log.Fatalf("push: %v", err)
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		fmt.Printf("%s %s -> %s\n", *serial, strings.TrimSpace(line), strings.TrimSpace(string(b)))
	}
	get("/iclock/getrequest?SN=" + url.QueryEscape(*serial))
}
