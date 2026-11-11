package escpos

import (
	"reflect"
	"testing"
)

func TestDecodeReceiptCommands(t *testing.T) {
	// ESC @, bold on, "TOTAL", LF, bold off, "caf\x82", LF, Code128 "AB", drawer, feed 3, cut
	in := []byte{ESC, 0x40, ESC, 0x45, 1, 'T', 'O', 'T', 'A', 'L', LF, ESC, 0x45, 0, 'c', 'a', 'f', 0x82, LF,
		GS, 0x6b, 73, 4, '{', 'B', 'A', 'B', ESC, 0x70, 0, 0x19, 0xfa, ESC, 0x64, 3, GS, 0x56, 0x42, 0}
	p := Decode(in)
	if !reflect.DeepEqual(p.Lines, []string{"TOTAL", "café"}) {
		t.Fatalf("lines: %q", p.Lines)
	}
	if !reflect.DeepEqual(p.Bold, []string{"TOTAL"}) || !reflect.DeepEqual(p.Barcodes, []string{"AB"}) || p.Cuts != 1 || p.DrawerKicks != 1 || p.Unknown != 0 {
		t.Fatalf("got %+v", p)
	}
}

func TestUnknownCommandsAreCountedNotGuessed(t *testing.T) {
	p := Decode([]byte{ESC, 0x99, 'x', GS, 0x99, LF, 0x07})
	if p.Unknown != 3 || !reflect.DeepEqual(p.Lines, []string{"x"}) {
		t.Fatalf("got %+v", p)
	}
}

func TestTruncatedStreamDoesNotPanic(t *testing.T) {
	for _, in := range [][]byte{{ESC}, {GS}, {GS, 0x6b}, {GS, 0x6b, 73, 200, 'a'}, {ESC, 0x70}, {GS, 0x56}} {
		_ = Decode(in)
	}
}
