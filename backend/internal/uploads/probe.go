package uploads

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type metadata struct {
	Duration         int64
	Codec, Container string
	Rate, Channels   int
}

// Probe uses an already-open local descriptor. Network protocols, playlists and
// external references are disabled. Output and runtime are bounded.
func probe(ctx context.Context, f *os.File) (metadata, string) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", "wav,mp3,flac,ogg,mov,matroska,webm,aac,aiff,asf", "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,sample_rate,channels,duration", "-of", "json", "/proc/self/fd/3")
	cmd.WaitDelay = time.Second
	cmd.ExtraFiles = []*os.File{f}
	var out limitedBuffer
	cmd.Stdout = &out
	cmd.Stderr = io.Discard
	if e := cmd.Run(); e != nil {
		if ctx.Err() != nil {
			return metadata{}, "probe_timeout"
		}
		if _, ok := e.(*exec.Error); ok {
			return metadata{}, "unavailable"
		}
		return metadata{}, "corrupt_audio"
	}
	var v struct {
		Streams []struct {
			Type     string `json:"codec_type"`
			Codec    string `json:"codec_name"`
			Rate     string `json:"sample_rate"`
			Channels int    `json:"channels"`
			Duration string `json:"duration"`
		}
		Format struct {
			Name     string `json:"format_name"`
			Duration string `json:"duration"`
		}
	}
	if json.Unmarshal(out.Bytes(), &v) != nil {
		return metadata{}, "corrupt_audio"
	}
	for _, s := range v.Streams {
		if s.Type != "audio" {
			continue
		}
		m := metadata{Codec: s.Codec, Container: v.Format.Name, Channels: s.Channels}
		m.Rate, _ = strconv.Atoi(s.Rate)
		if s.Codec == "" || s.Codec == "unknown" {
			return m, "unsupported_codec"
		}
		d, e := strconv.ParseFloat(s.Duration, 64)
		if e != nil {
			d, e = strconv.ParseFloat(v.Format.Duration, 64)
		}
		if e != nil || math.IsNaN(d) || math.IsInf(d, 0) || d <= 0 {
			return metadata{}, "corrupt_audio"
		}
		if d < 1e9 {
			m.Duration = int64(math.Ceil(d * 1000))
		}
		if d > 1200 {
			return m, "too_long"
		}
		rate, e := strconv.Atoi(s.Rate)
		if e != nil || rate <= 0 || s.Channels <= 0 {
			return metadata{}, "corrupt_audio"
		}
		// A known codec name alone does not imply this binary has its decoder.
		decoders := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-decoders")
		decoders.WaitDelay = time.Second
		var available limitedBuffer
		decoders.Stdout = &available
		decoders.Stderr = io.Discard
		if e := decoders.Run(); e != nil {
			if ctx.Err() != nil {
				return metadata{}, "probe_timeout"
			}
			return metadata{}, "unavailable"
		}
		supported := false
		for _, line := range strings.Split(available.String(), "\n") {
			fields := strings.Fields(line)
			if len(fields) > 1 && strings.HasPrefix(fields[0], "A") && (fields[1] == s.Codec || strings.Contains(line, "(codec "+s.Codec+")")) {
				supported = true
				break
			}
		}
		if !supported {
			return m, "unsupported_codec"
		}
		return m, ""
	}
	return metadata{Container: v.Format.Name}, "unsupported_codec"
}

type limitedBuffer struct{ bytes.Buffer }

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 64<<10 {
		return 0, io.ErrShortBuffer
	}
	return b.Buffer.Write(p)
}
