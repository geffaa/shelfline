// Package queue is a small durable FIFO: one file per event, named by a zero-padded sequence number, written atomically.
// It survives a restart or a power cut with nothing lost and the order intact, and needs nothing but the standard library.
package queue

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Event is one attendance record, normalised from whatever the terminal said.
type Event struct {
	Serial     string `json:"serial"`
	PersonCode string `json:"personCode"`
	TS         string `json:"ts"` // RFC 3339 with offset
	Verify     string `json:"verify"`
	State      string `json:"state,omitempty"` // "in", "out" or empty when the terminal does not say
}

type Queue struct {
	mu   sync.Mutex
	dir  string
	dead string
	next uint64
}

// Open creates the directory if needed and continues the sequence after the highest file already there.
func Open(dir string) (*Queue, error) {
	q := &Queue{dir: filepath.Join(dir, "queue"), dead: filepath.Join(dir, "dead")}
	for _, d := range []string{q.dir, q.dead} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return nil, err
		}
	}
	names, err := q.names()
	if err != nil {
		return nil, err
	}
	if len(names) > 0 {
		last := strings.TrimSuffix(names[len(names)-1], ".json")
		n, err := strconv.ParseUint(last, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("unexpected file %q in queue: %w", names[len(names)-1], err)
		}
		q.next = n + 1
	}
	// leftovers from a crash between write and rename are not events
	tmp, _ := filepath.Glob(filepath.Join(q.dir, "*.tmp"))
	for _, t := range tmp {
		_ = os.Remove(t)
	}
	return q, nil
}

func (q *Queue) names() ([]string, error) {
	ents, err := os.ReadDir(q.dir)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range ents {
		if strings.HasSuffix(e.Name(), ".json") {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out, nil
}

// Push appends one event. When it returns nil the event is on disk.
func (q *Queue) Push(e Event) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	name := fmt.Sprintf("%020d.json", q.next)
	tmp := filepath.Join(q.dir, name+".tmp")
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(q.dir, name)); err != nil {
		return err
	}
	q.next++
	return nil
}

// Item is an event with the file it lives in, so it can be acknowledged by name.
type Item struct {
	Name  string
	Event Event
}

// Peek returns up to n of the oldest events without removing them.
func (q *Queue) Peek(n int) ([]Item, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	names, err := q.names()
	if err != nil {
		return nil, err
	}
	if len(names) > n {
		names = names[:n]
	}
	out := make([]Item, 0, len(names))
	for _, name := range names {
		b, err := os.ReadFile(filepath.Join(q.dir, name))
		if err != nil {
			return nil, err
		}
		var e Event
		if err := json.Unmarshal(b, &e); err != nil {
			// a file that cannot be read is set aside, never allowed to block the line
			_ = os.Rename(filepath.Join(q.dir, name), filepath.Join(q.dead, name))
			continue
		}
		out = append(out, Item{Name: name, Event: e})
	}
	return out, nil
}

// Ack removes events the server has dealt with.
func (q *Queue) Ack(items []Item) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, it := range items {
		if err := os.Remove(filepath.Join(q.dir, it.Name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

// Quarantine moves an event the server will never accept out of the line, keeping it for a person to look at.
func (q *Queue) Quarantine(it Item) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	return os.Rename(filepath.Join(q.dir, it.Name), filepath.Join(q.dead, it.Name))
}

func (q *Queue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	n, _ := q.names()
	return len(n)
}

func (q *Queue) DeadLen() int {
	ents, _ := os.ReadDir(q.dead)
	return len(ents)
}
