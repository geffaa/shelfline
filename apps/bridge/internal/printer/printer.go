// Package printer carries print jobs from Shelfline to receipt printers on the store network. It asks the server for work (signed, like
// attendance batches), sends the exact bytes to the printer over TCP, and reports what happened. A job that was claimed and never reported
// goes back to the queue on the server, so a crash here loses nothing.
package printer

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"shelfline/bridge/internal/sender"
)

type Job struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Host    string `json:"host"`
	Port    int    `json:"port"`
	Payload string `json:"payload"`
	Attempt int    `json:"attempt"`
}

type Status struct {
	Printed   int       `json:"printed"`
	Failed    int       `json:"failed"`
	LastOKAt  time.Time `json:"lastOkAt"`
	LastError string    `json:"lastError"`
}

type Relay struct {
	Server   string
	BridgeID string
	Secret   string
	Client   *http.Client
	Dial     func(network, address string, timeout time.Duration) (net.Conn, error)
	Now      func() time.Time
	Max      int
	mu       sync.Mutex
	st       Status
}

func (r *Relay) Status() Status { r.mu.Lock(); defer r.mu.Unlock(); return r.st }

func (r *Relay) post(path string, body any, out any) error {
	if r.Client == nil {
		r.Client = &http.Client{Timeout: 15 * time.Second}
	}
	if r.Now == nil {
		r.Now = time.Now
	}
	b, _ := json.Marshal(body)
	ts := strconv.FormatInt(r.Now().Unix(), 10)
	req, _ := http.NewRequest(http.MethodPost, r.Server+path, bytes.NewReader(b))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-bridge-id", r.BridgeID)
	req.Header.Set("x-timestamp", ts)
	req.Header.Set("x-signature", sender.Sign(r.Secret, ts, b))
	res, err := r.Client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("server answered %d: %s", res.StatusCode, string(data))
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

// Send writes the bytes to the printer and closes the connection. Printers answer nothing on port 9100, so "written and closed without an error" is all there is to know.
func (r *Relay) Send(j Job) error {
	dial := r.Dial
	if dial == nil {
		dial = net.DialTimeout
	}
	raw, err := base64.StdEncoding.DecodeString(j.Payload)
	if err != nil {
		return fmt.Errorf("bad payload: %w", err)
	}
	c, err := dial("tcp", net.JoinHostPort(j.Host, strconv.Itoa(j.Port)), 4*time.Second)
	if err != nil {
		return err
	}
	defer c.Close()
	_ = c.SetWriteDeadline(r.Now().Add(8 * time.Second))
	_, err = c.Write(raw)
	return err
}

// Once claims what is waiting, prints it, and reports each result. It returns how many were printed.
func (r *Relay) Once() (int, error) {
	if r.Now == nil {
		r.Now = time.Now
	}
	max := r.Max
	if max == 0 {
		max = 5
	}
	var out struct{ Jobs []Job }
	if err := r.post("/devices/print-jobs/claim", map[string]int{"max": max}, &out); err != nil {
		r.mu.Lock()
		r.st.LastError = err.Error()
		r.mu.Unlock()
		return 0, err
	}
	done := 0
	for _, j := range out.Jobs {
		sendErr := r.Send(j)
		rep := map[string]any{"id": j.ID, "ok": sendErr == nil}
		if sendErr != nil {
			rep["error"] = sendErr.Error()
		}
		repErr := r.post("/devices/print-jobs/result", rep, nil)
		r.mu.Lock()
		if sendErr == nil {
			r.st.Printed++
			r.st.LastOKAt, r.st.LastError = r.Now(), ""
			done++
		} else {
			r.st.Failed++
			r.st.LastError = sendErr.Error()
		}
		r.mu.Unlock()
		if repErr != nil {
			return done, repErr
		}
	}
	return done, nil
}
