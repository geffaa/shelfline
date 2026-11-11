package queue

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func ev(i int) Event { return Event{Serial: "S", PersonCode: fmt.Sprint(i), TS: "2026-11-04T09:00:00+11:00", Verify: "fingerprint"} }

func TestOrderSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	q, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if err := q.Push(ev(i)); err != nil {
			t.Fatal(err)
		}
	}
	first, _ := q.Peek(2)
	_ = q.Ack(first)
	q2, err := Open(dir) // the machine was switched off and on
	if err != nil {
		t.Fatal(err)
	}
	if q2.Len() != 3 {
		t.Fatalf("len %d", q2.Len())
	}
	_ = q2.Push(ev(5))
	all, _ := q2.Peek(10)
	var got []string
	for _, it := range all {
		got = append(got, it.Event.PersonCode)
	}
	if fmt.Sprint(got) != "[2 3 4 5]" {
		t.Fatalf("order %v", got)
	}
}

func TestLeftoversAndBadFilesDoNotBlock(t *testing.T) {
	dir := t.TempDir()
	q, _ := Open(dir)
	_ = q.Push(ev(1))
	_ = os.WriteFile(filepath.Join(dir, "queue", "00000000000000000000.json.tmp"), []byte("{"), 0o644) // a write that never finished
	_ = os.WriteFile(filepath.Join(dir, "queue", "00000000000000000009.json"), []byte("not json"), 0o644)
	q2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	items, _ := q2.Peek(10)
	if len(items) != 1 || items[0].Event.PersonCode != "1" || q2.DeadLen() != 1 {
		t.Fatalf("items %v dead %d", items, q2.DeadLen())
	}
	if _, err := os.Stat(filepath.Join(dir, "queue", "00000000000000000000.json.tmp")); !os.IsNotExist(err) {
		t.Fatal("tmp file should be cleaned")
	}
}
