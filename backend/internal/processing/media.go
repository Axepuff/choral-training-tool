// Package processing runs bounded, durable audio processing in the service process.
package processing

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Linux deployment: prlimit applies hard limits before exec, without a shell.
// Two single-threaded jobs use at most 2 GiB address space and 64 MiB output each.
func command(ctx context.Context, binary string, files []*os.File, args ...string) *exec.Cmd {
	argv := append([]string{"--as=1073741824", "--cpu=300", "--fsize=67108864", "--nofile=64", "--", binary}, args...)
	c := exec.CommandContext(ctx, "prlimit", argv...)
	c.ExtraFiles = files
	c.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	c.Stderr = io.Discard
	c.WaitDelay = time.Second
	return c
}

type bounded struct{ data []byte }

func (b *bounded) Write(p []byte) (int, error) {
	if len(b.data)+len(p) > 65536 {
		return 0, io.ErrShortBuffer
	}
	b.data = append(b.data, p...)
	return len(p), nil
}

// CheckTools fails startup rather than accepting jobs that cannot be processed.
func CheckTools(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	for _, spec := range []struct{ name, flag, want string }{
		{"ffmpeg", "-encoders", " aac "},
		{"ffmpeg", "-encoders", " pcm_f32le "},
		{"ffmpeg", "-decoders", " aac "},
		{"ffmpeg", "-muxers", " mp4 "},
		{"ffmpeg", "-muxers", " f32le "},
		{"ffmpeg", "-filters", " aresample "},
		{"ffmpeg", "-filters", " asetpts "},
		{"ffprobe", "-version", "ffprobe version"},
	} {
		var out bounded
		c := command(ctx, spec.name, nil, "-v", "error", spec.flag)
		c.Stdout = &out
		if e := c.Run(); e != nil {
			return e
		}
		if !strings.Contains(string(out.data), spec.want) {
			return errors.New("required audio processing capability unavailable")
		}
	}
	return nil
}

type wave struct {
	Start    int          `json:"startMs"`
	Step     int          `json:"stepMs"`
	Duration int64        `json:"durationMs"`
	Points   [][2]float64 `json:"points"`
}

// PCM is read incrementally: memory is bounded by 12,001 windows, not file length.
func readWave(r io.Reader) (wave, error) {
	r = bufio.NewReaderSize(r, 64<<10)
	w := wave{Step: 100, Points: make([][2]float64, 0, 12000)}
	var sample [4]byte
	var n int64
	var lo, hi float64
	for {
		_, e := io.ReadFull(r, sample[:])
		if e == io.EOF {
			break
		}
		if e != nil {
			return w, e
		}
		x := float64(math.Float32frombits(binary.LittleEndian.Uint32(sample[:])))
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return w, errors.New("invalid PCM")
		}
		x = math.Max(-1, math.Min(1, x))
		if n%4800 == 0 {
			lo, hi = x, x
		}
		lo = math.Min(lo, x)
		hi = math.Max(hi, x)
		n++
		if n > 48000*1200+1024 {
			return w, errors.New("too_long")
		}
		if n%4800 == 0 {
			w.Points = append(w.Points, [2]float64{lo, hi})
		}
	}
	if n == 0 {
		return w, errors.New("empty PCM")
	}
	if n%4800 != 0 {
		w.Points = append(w.Points, [2]float64{lo, hi})
	}
	w.Duration = (n*1000 + 47999) / 48000
	return w, nil
}

func verify(ctx context.Context, f *os.File) (int64, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var out bounded
	c := command(ctx, "ffprobe", []*os.File{f}, "-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=duration:stream=codec_type,codec_name,profile,sample_rate,channels,start_time,duration", "-of", "json", "/proc/self/fd/3")
	c.Stdout = &out
	if e := c.Run(); e != nil {
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		// Process failures are infrastructure errors and remain retryable.
		// Only successfully read but invalid metadata is a terminal result.
		return 0, e
	}
	var v struct {
		Streams []struct {
			Type     string `json:"codec_type"`
			Codec    string `json:"codec_name"`
			Profile  string `json:"profile"`
			Rate     string `json:"sample_rate"`
			Channels int    `json:"channels"`
			Start    string `json:"start_time"`
			Duration string `json:"duration"`
		}
	}
	if e := json.Unmarshal(out.data, &v); e != nil {
		return 0, &mediaError{"invalid_result"}
	}
	if len(v.Streams) != 1 {
		return 0, &mediaError{"invalid_result"}
	}
	s := v.Streams[0]
	d, e := strconv.ParseFloat(s.Duration, 64)
	start, se := strconv.ParseFloat(s.Start, 64)
	if e != nil || se != nil || math.IsNaN(d) || math.IsInf(d, 0) || d <= 0 || d > 1200 || math.Abs(start) > 0.001 || s.Type != "audio" || s.Codec != "aac" || s.Profile != "LC" || s.Rate != "48000" || s.Channels != 1 {
		return 0, &mediaError{"invalid_result"}
	}
	return int64(math.Round(d * 1000)), nil
}
