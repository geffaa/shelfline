// Package escpos reads the part of the ESC/POS printer language that receipts use. The virtual printer uses it to show what a real printer would print.
package escpos

import "strings"

const (
	ESC = 0x1b
	GS  = 0x1d
	LF  = 0x0a
)

// Printout is what a stream of printer commands amounts to.
type Printout struct {
	Lines       []string
	Cuts        int
	DrawerKicks int
	Barcodes    []string
	Bold        []string
	Unknown     int
}

// Text is the lines joined with newlines.
func (p Printout) Text() string { return strings.Join(p.Lines, "\n") }

// cp437High are the characters 0x80 to 0xFF in code page 437.
var cp437High = []rune("ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ")

func decode(b []byte) string {
	out := make([]rune, 0, len(b))
	for _, c := range b {
		if c >= 0x80 {
			out = append(out, cp437High[c-0x80])
		} else {
			out = append(out, rune(c))
		}
	}
	return string(out)
}

// Decode reads a byte stream. Commands it does not know are counted rather than guessed at.
func Decode(a []byte) Printout {
	var p Printout
	var cur []byte
	bold, lineBold := false, false
	flush := func() {
		t := decode(cur)
		p.Lines = append(p.Lines, t)
		if lineBold && strings.TrimSpace(t) != "" {
			p.Bold = append(p.Bold, strings.TrimSpace(t))
		}
		cur, lineBold = nil, false
	}
	at := func(i int) byte {
		if i < len(a) {
			return a[i]
		}
		return 0
	}
	for i := 0; i < len(a); i++ {
		c := a[i]
		switch {
		case c == LF:
			flush()
		case c == ESC:
			i++
			switch at(i) {
			case 0x40:
				bold = false
			case 0x61, 0x64, 0x4d, 0x32:
				i++
			case 0x45:
				i++
				bold = at(i) == 1
			case 0x70:
				i += 3
				p.DrawerKicks++
			default:
				p.Unknown++
			}
		case c == GS:
			i++
			switch at(i) {
			case 0x56:
				if at(i+1) == 0x42 || at(i+1) == 0x41 {
					i += 2
				} else {
					i++
				}
				p.Cuts++
			case 0x21, 0x48, 0x68, 0x77:
				i++
			case 0x6b:
				i++
				if at(i) >= 65 {
					i++
					n := int(at(i))
					end := i + 1 + n
					if end > len(a) {
						end = len(a)
					}
					code := decode(a[i+1 : end])
					if len(code) > 2 && code[0] == '{' {
						code = code[2:]
					}
					p.Barcodes = append(p.Barcodes, code)
					i += n
				} else {
					p.Unknown++
				}
			default:
				p.Unknown++
			}
		case c >= 0x20:
			cur = append(cur, c)
			if bold {
				lineBold = true
			}
		default:
			p.Unknown++
		}
	}
	if len(cur) > 0 {
		flush()
	}
	return p
}
