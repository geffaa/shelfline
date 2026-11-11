// Package sender forwards queued events to Shelfline in order, in signed batches, and survives any outage by simply trying again.
package sender

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"

	"shelfline/bridge/internal/queue"
)

// Sign is HMAC-SHA256 over "<unix seconds>.<exact request body>", hex encoded. The server recomputes it from its own derived key.
func Sign(secret, ts string, body []byte) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(ts + "."))
	m.Write(body)
	return hex.EncodeToString(m.Sum(nil))
}

type Status struct {
	LastSendAt time.Time `json:"lastSendAt"`
	LastError  string    `json:"lastError"`
	LastOKAt   time.Time `json:"lastOkAt"`
	Sent       int       `json:"sent"`
	Accepted   int       `json:"accepted"`
	Duplicates int       `json:"duplicates"`
	Review     int       `json:"needsReview"`
}

type Sender struct {
	Q        *queue.Queue
	Server   string
	BridgeID string
	Secret   string
	Client   *http.Client
	Batch    int
	Now      func() time.Time
	mu       sync.Mutex
	st       Status
}

func (s *Sender) Status() Status { s.mu.Lock(); defer s.mu.Unlock(); return s.st }
func (s *Sender) fail(err error) {
	s.mu.Lock()
	s.st.LastError, s.st.LastSendAt = err.Error(), s.Now()
	s.mu.Unlock()
}

type result struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
}

// Flush sends batches until the queue is empty or something goes wrong. It returns (events delivered, error). Nothing is removed from the queue
// until the server has answered 200, so an outage costs time, never records, and the order is the order the terminals gave them.
func (s *Sender) Flush() (int, error) {
	if s.Now == nil {
		s.Now = time.Now
	}
	if s.Client == nil {
		s.Client = &http.Client{Timeout: 20 * time.Second}
	}
	if s.Batch == 0 {
		s.Batch = 100
	}
	total := 0
	for {
		items, err := s.Q.Peek(s.Batch)
		if err != nil {
			s.fail(err)
			return total, err
		}
		if len(items) == 0 {
			return total, nil
		}
		events := make([]queue.Event, len(items))
		for i, it := range items {
			events[i] = it.Event
		}
		body, _ := json.Marshal(map[string]any{"events": events})
		ts := strconv.FormatInt(s.Now().Unix(), 10)
		req, _ := http.NewRequest(http.MethodPost, s.Server+"/devices/punches", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-bridge-id", s.BridgeID)
		req.Header.Set("x-timestamp", ts)
		req.Header.Set("x-signature", Sign(s.Secret, ts, body))
		res, err := s.Client.Do(req)
		if err != nil {
			s.fail(err)
			return total, err
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		switch {
		case res.StatusCode == http.StatusOK:
			var out struct{ Results []result }
			_ = json.Unmarshal(b, &out)
			s.mu.Lock()
			for _, r := range out.Results {
				switch r.Status {
				case "accepted":
					s.st.Accepted++
				case "duplicate":
					s.st.Duplicates++
				case "needs_review":
					s.st.Review++
				}
			}
			s.st.Sent += len(items)
			s.st.LastSendAt, s.st.LastOKAt, s.st.LastError = s.Now(), s.Now(), ""
			s.mu.Unlock()
			if err := s.Q.Ack(items); err != nil {
				s.fail(err)
				return total, err
			}
			total += len(items)
		case res.StatusCode == http.StatusBadRequest && len(items) >= 1:
			// the server will never accept this content: set the oldest aside so the rest are not stuck behind it
			_ = s.Q.Quarantine(items[0])
			s.fail(fmt.Errorf("server refused an event as malformed; set aside: %s", string(b)))
		default:
			err := fmt.Errorf("server answered %d: %s", res.StatusCode, string(b))
			s.fail(err)
			return total, err
		}
	}
}

// Run flushes on an interval, backing off after failures (up to a minute) and returning to the normal pace on success.
func (s *Sender) Run(stop <-chan struct{}, every time.Duration) {
	wait := every
	for {
		select {
		case <-stop:
			return
		case <-time.After(wait):
		}
		if _, err := s.Flush(); err != nil {
			if wait *= 2; wait > time.Minute {
				wait = time.Minute
			}
		} else {
			wait = every
		}
	}
}
