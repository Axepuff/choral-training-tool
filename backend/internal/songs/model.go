// Package songs implements private, session-authorized song metadata API v1.
package songs

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

var uuid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var invalid = errors.New("validation_error")

type Track struct {
	ID         string  `json:"id"`
	Position   int     `json:"position"`
	Name       string  `json:"name"`
	Gain       float64 `json:"gain"`
	Status     string  `json:"status"`
	Duration   *int64  `json:"durationMs"`
	Media      *string `json:"mediaUrl"`
	Peaks      *string `json:"peaksUrl"`
	PendingJob *string `json:"pendingJobId,omitempty"`
}
type Song struct {
	ID          string  `json:"id"`
	Owner       string  `json:"ownerId"`
	Title       string  `json:"title"`
	BPM         int     `json:"bpm"`
	Beats       int     `json:"beatsPerBar"`
	Unit        int     `json:"beatUnit"`
	Notes       string  `json:"notes"`
	Publication string  `json:"publication"`
	Ready       bool    `json:"ready"`
	Duration    *int64  `json:"durationMs"`
	Bars        *int64  `json:"barCount"`
	Version     int64   `json:"version"`
	Updated     string  `json:"updatedAt"`
	Tracks      []Track `json:"tracks"`
}
type trackWrite struct {
	ID       *string  `json:"id,omitempty"`
	Name     *string  `json:"name"`
	Position *int     `json:"position"`
	Gain     *float64 `json:"gain"`
}
type songWrite struct {
	Title       *string      `json:"title"`
	BPM         *int         `json:"bpm"`
	Beats       *int         `json:"beatsPerBar"`
	Unit        *int         `json:"beatUnit"`
	Notes       *string      `json:"notes"`
	Publication *string      `json:"publication"`
	Tracks      []trackWrite `json:"tracks"`
}

func normalize(v *string, max int, trim bool) bool {
	if v == nil {
		return false
	}
	*v = norm.NFC.String(*v)
	if trim {
		*v = strings.TrimSpace(*v)
	}
	n := utf8.RuneCountInString(*v)
	return n <= max && (!trim || n > 0) && !strings.ContainsRune(*v, 0)
}
func (in *songWrite) validate(create bool) error {
	if !normalize(in.Title, 160, true) || !normalize(in.Notes, 1000, false) || in.BPM == nil || *in.BPM < 20 || *in.BPM > 300 || in.Beats == nil || *in.Beats < 1 || *in.Beats > 32 || in.Unit == nil || in.Publication == nil {
		return invalid
	}
	switch *in.Unit {
	case 1, 2, 4, 8, 16, 32:
	default:
		return invalid
	}
	if *in.Publication != "draft" && *in.Publication != "published" || create && *in.Publication != "draft" || len(in.Tracks) < 1 || len(in.Tracks) > 32 {
		return invalid
	}
	positions := map[int]bool{}
	ids := map[string]bool{}
	for _, t := range in.Tracks {
		if !normalize(t.Name, 80, true) || t.Position == nil || *t.Position < 0 || *t.Position >= len(in.Tracks) || positions[*t.Position] || t.Gain == nil || math.IsNaN(*t.Gain) || math.IsInf(*t.Gain, 0) || *t.Gain < 0 || *t.Gain > 1 {
			return invalid
		}
		positions[*t.Position] = true
		if t.ID != nil {
			if create || !uuid.MatchString(*t.ID) || ids[*t.ID] {
				return invalid
			}
			ids[*t.ID] = true
		}
	}
	sort.Slice(in.Tracks, func(i, j int) bool { return *in.Tracks[i].Position < *in.Tracks[j].Position })
	return nil
}

// Validate raw JSON strings as well as UTF-8: encoding/json silently repairs lone surrogates.
func validUnicode(b []byte) bool {
	if !utf8.Valid(b) {
		return false
	}
	for i := 0; i < len(b); i++ {
		if b[i] != '"' {
			continue
		}
		start := i
		i++
		for i < len(b) && b[i] != '"' {
			if b[i] == '\\' {
				i++
			}
			i++
		}
		if i >= len(b) {
			return false
		}
		raw := b[start : i+1]
		for j := 1; j < len(raw)-1; j++ {
			if raw[j] != '\\' {
				continue
			}
			j++
			if raw[j] != 'u' {
				continue
			}
			if j+4 >= len(raw) {
				return false
			}
			var v uint16
			for _, c := range raw[j+1 : j+5] {
				v *= 16
				switch {
				case c >= '0' && c <= '9':
					v += uint16(c - '0')
				case c >= 'a' && c <= 'f':
					v += uint16(c - 'a' + 10)
				case c >= 'A' && c <= 'F':
					v += uint16(c - 'A' + 10)
				default:
					return false
				}
			}
			j += 4
			if v >= 0xdc00 && v <= 0xdfff {
				return false
			}
			if v >= 0xd800 && v <= 0xdbff {
				if j+6 >= len(raw) || raw[j+1] != '\\' || raw[j+2] != 'u' {
					return false
				}
				low := strings.ToLower(string(raw[j+3 : j+7]))
				if low[0] != 'd' || !strings.ContainsRune("cdef", rune(low[1])) {
					return false
				}
				for _, c := range low[2:] {
					if !strings.ContainsRune("0123456789abcdef", c) {
						return false
					}
				}
				j += 6
			}
		}
	}
	return true
}
func decode(w http.ResponseWriter, r *http.Request, in *songWrite) bool {
	typ, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || typ != "application/json" {
		fail(w, 422, "validation_error")
		return false
	}
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil {
		fail(w, 413, "payload_too_large")
		return false
	}
	if !validUnicode(b) {
		fail(w, 422, "validation_error")
		return false
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err = d.Decode(in); err != nil {
		fail(w, 422, "validation_error")
		return false
	}
	if d.Decode(new(any)) != io.EOF || !exactFields(b) || in.validate(r.Method == "POST") != nil {
		fail(w, 422, "validation_error")
		return false
	}
	return true
}

// encoding/json matches keys without regard to case and conflates absent/null
// optional pointers. The wire contract allows only exact keys and non-null IDs.
func exactFields(b []byte) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(b, &fields) != nil {
		return false
	}
	for k := range fields {
		switch k {
		case "title", "bpm", "beatsPerBar", "beatUnit", "notes", "publication", "tracks":
		default:
			return false
		}
	}
	var tracks []map[string]json.RawMessage
	if json.Unmarshal(fields["tracks"], &tracks) != nil {
		return false
	}
	for _, t := range tracks {
		for k, v := range t {
			switch k {
			case "id":
				if bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
					return false
				}
			case "name", "position", "gain":
			default:
				return false
			}
		}
	}
	return true
}
